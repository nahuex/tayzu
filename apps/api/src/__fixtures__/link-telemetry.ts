/**
 * Readers for the account-linking signals of task 20.4 (design D24, "Metrics"
 * and "Log events" tables): the `tayzu.auth.account_link.events` counter and
 * the `auth.security.account_linked` / `auth.security.account_unlinked` log
 * events.
 *
 * Import order is load-bearing (design D1, `packages/observability/CLAUDE.md`):
 * the test file must import `registration` from this module (or the auth
 * package's `registered-harness`) BEFORE anything that loads `@tayzu/auth`,
 * because the OTel metrics API has no proxy meter provider.
 */
import type { TelemetryTestHarness } from '../../../../packages/auth/src/__fixtures__/registered-harness.js';

export {
  registration,
  type TelemetryTestHarness,
} from '../../../../packages/auth/src/__fixtures__/registered-harness.js';

const METRIC_DATA_POINT_TYPE_SUM = 3;

export const LINK_COUNTER = 'tayzu.auth.account_link.events';

export interface LinkEventPoint {
  readonly event: unknown;
  readonly actor: unknown;
  readonly value: number;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export function linkCounterPoints(harness: TelemetryTestHarness): readonly LinkEventPoint[] {
  const points: LinkEventPoint[] = [];
  for (const resourceMetrics of harness.metricExporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (
          metric.descriptor.name === LINK_COUNTER &&
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
          metric.dataPointType === METRIC_DATA_POINT_TYPE_SUM
        ) {
          for (const point of metric.dataPoints) {
            points.push({
              event: point.attributes['tayzu.auth.event'],
              actor: point.attributes['tayzu.auth.link.actor'],
              value: point.value,
              attributes: point.attributes,
            });
          }
        }
      }
    }
  }
  return points;
}

export function linkCounterTotal(
  harness: TelemetryTestHarness,
  event: 'linked' | 'unlinked',
  actor: 'self' | 'admin',
): number {
  return linkCounterPoints(harness)
    .filter((point) => point.event === event && point.actor === actor)
    .reduce((sum, point) => sum + point.value, 0);
}

export async function linkLogEvents(harness: TelemetryTestHarness, eventName: string) {
  await harness.forceFlush();
  return [...harness.logExporter.getFinishedLogRecords()].filter(
    (record) => record.eventName === eventName,
  );
}
