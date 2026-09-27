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
  exporters on the global providers and exposes `reset()` and `shutdown()`.
  Tests call `reset()` between cases and `shutdown()` when they finish.
- Tests emit through the OTel **API**, exactly like production code, and never
  write to an exporter directly. The harness must see what production emits.
- `@opentelemetry/instrumentation-pg` is always configured with
  `enhancedDatabaseReporting: false`, so SQL bind values never reach a span.
  The harness uses the same configuration as host apps.
- Keep the exported surface small and documented: host apps and tests are the
  only consumers.

## Tests

- Unit tests only (`src/**/*.test.ts`). This package needs no database.
- Run them with `pnpm --filter @tayzu/observability test`.
