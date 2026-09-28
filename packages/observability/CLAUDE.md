# @tayzu/observability

The OpenTelemetry test harness and the SDK bootstrap helper for host apps.
Global rules are in the root `CLAUDE.md`. The signals themselves are declared
in each change's design, in the "Observability contract" section.

## Role

- This is the only workspace package that depends on the OTel **SDK**
  (`sdk-trace-base`, `sdk-metrics`, `sdk-logs`, `resources`,
  `context-async-hooks`) and on `@opentelemetry/instrumentation-pg`.
- Libraries (`@tayzu/catalog`, `@tayzu/db`) depend on `@opentelemetry/api`
  and `@opentelemetry/api-logs` only. They use this package as a
  devDependency, for tests.
- No exporter to Azure Monitor in 001. The host app wires exporters in a later
  change (002 or 010).
- This package defines no signal names or attributes. Those belong to each
  capability's `telemetry/contract.ts`.

## Conventions

- `createTelemetryTestHarness()` registers in-memory span, metric and log
  exporters on the global providers and exposes `spanExporter`,
  `metricExporter`, `logExporter`, `pgInstrumentation`, `forceFlush()`,
  `reset()` and `shutdown()`. Tests call `reset()` between cases and
  `shutdown()` when they finish (or when a test needs a second harness).
- Tests emit through the OTel **API**, exactly like production code, and never
  write to an exporter directly. The harness must see what production emits.
- **Single registration.** Only one harness registers at a time. A second
  `createTelemetryTestHarness()` call while one is active throws and leaves
  nothing behind (no provider or pg instrumentation of the failed attempt
  stays reachable). Call `shutdown()` on the active harness first.
- **Import order.** Register the harness before any module that creates its
  instruments at import time (design D1): a Vitest setup file, or the first
  import of a test file, per `src/__fixtures__/registered-harness.ts`. The
  OTel metrics API has no proxy meter provider, so a `Meter` obtained before
  registration is a no-op forever, and an instrumentation (`PgInstrumentation`)
  captures whatever tracer, meter and logger are registered at its own
  construction time.
- **`reset()` semantics**: empties the three exporters. Nothing recorded
  before it is exported after it (a counter counts from zero again), and it
  discards whatever was emitted but not flushed. Every instrument obtained
  before `reset()` keeps capturing afterwards: `reset()` drains and clears the
  exporters, it never replaces a provider.
- **Temporality**: metrics are collected with delta aggregation temporality,
  so each `forceFlush()` (direct, or through `reset()`) reports only the
  activity recorded since the previous collection. This is what makes
  `reset()`'s "counts from zero again" possible without recreating the
  `MeterProvider`.
- **`shutdown()`** shuts the tracer, meter and logger providers down, disables
  the pg instrumentation, and releases the OTel globals (providers and context
  manager) so a new harness can register. Nothing emitted afterwards reaches
  its exporters, even through instruments obtained while it was registered.
- `@opentelemetry/instrumentation-pg` is always configured with
  `enhancedDatabaseReporting: false`, so SQL bind values never reach a span.
  The harness uses the same configuration as host apps.
- Keep the exported surface small and documented: host apps and tests are the
  only consumers. The full contract is documented in `src/harness.ts`'s JSDoc.

## Tests

- Unit tests only (`src/**/*.test.ts`). This package needs no database.
- Run them with `pnpm --filter @tayzu/observability test`.
