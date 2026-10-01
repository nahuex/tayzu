/**
 * Task 23.13 (design Q41, D14): outside test, startup fails when no OTLP
 * endpoint is configured, unless `TAYZU_TELEMETRY_DISABLED=true` is set
 * explicitly (which logs exactly one startup warning). No spec scenario; the
 * Verify clause is the contract.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/telemetry.ts
 * startTelemetry(env): Telemetry | undefined
 * ```
 *
 * - Outside test (`env.NODE_ENV ?? process.env.NODE_ENV` is not `test`), with
 *   no OTLP endpoint variable set and `TAYZU_TELEMETRY_DISABLED` not `true`,
 *   it THROWS an `Error` that names `OTEL_EXPORTER_OTLP_ENDPOINT` and
 *   `TAYZU_TELEMETRY_DISABLED`.
 * - With an endpoint it starts the SDK and returns a `Telemetry`.
 * - With `TAYZU_TELEMETRY_DISABLED=true` (and no endpoint) it returns
 *   `undefined` and emits exactly ONE warning (through `console.warn`,
 *   `process.stderr.write` or `process.emitWarning`) that mentions
 *   `TAYZU_TELEMETRY_DISABLED`.
 * - In test (`NODE_ENV=test`) the existing behavior is unchanged: no endpoint
 *   returns `undefined` without throwing (otel-export.int.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startTelemetry } from './telemetry.js';

type Env = Record<string, string | undefined>;

const ENDPOINT = 'http://127.0.0.1:1';

function prod(overrides: Env = {}): Env {
  return { NODE_ENV: 'production', ...overrides };
}

/** Counts the warnings emitted through any of the plausible channels. */
function captureWarnings(): () => string[] {
  const seen: string[] = [];
  const record = (chunk: unknown): void => {
    seen.push(typeof chunk === 'string' ? chunk : chunk instanceof Error ? chunk.message : '');
  };
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    record(args.map(String).join(' '));
  });
  vi.spyOn(process, 'emitWarning').mockImplementation((warning: string | Error) => {
    record(warning);
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    record(chunk);
    return true;
  });
  return () => seen.filter((line) => line.includes('TAYZU_TELEMETRY_DISABLED'));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('startup requires an OTLP endpoint outside test (Q41, D14)', () => {
  it('fails startup when no endpoint is configured outside test', () => {
    vi.stubEnv('NODE_ENV', 'production');
    let caught: unknown;
    try {
      startTelemetry(prod());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(message).toContain('TAYZU_TELEMETRY_DISABLED');
  });

  it('fails when the flag is set to anything but the exact value true', () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const value of ['false', '1', 'TRUE', 'yes', '']) {
      expect(() => startTelemetry(prod({ TAYZU_TELEMETRY_DISABLED: value }))).toThrow(
        /TAYZU_TELEMETRY_DISABLED/,
      );
    }
  });

  it('passes with an endpoint configured, and starts the SDK', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warnings = captureWarnings();
    const telemetry = startTelemetry(prod({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }));
    try {
      expect(telemetry).toBeDefined();
      expect(warnings()).toHaveLength(0);
    } finally {
      await telemetry?.shutdown().catch(() => undefined);
    }
  });

  it('passes with the explicit disable flag and logs exactly one startup warning', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warnings = captureWarnings();
    expect(startTelemetry(prod({ TAYZU_TELEMETRY_DISABLED: 'true' }))).toBeUndefined();
    expect(warnings()).toHaveLength(1);
  });

  it('does not fail in test without an endpoint', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(startTelemetry({ NODE_ENV: 'test' })).toBeUndefined();
  });
});
