/**
 * Process entry point (task 11.14, resolved decision Q30). Builds the app with
 * `createAppFromEnv`, listens on `HOST`/`PORT` and, on `SIGTERM`/`SIGINT`,
 * closes the listener and then every pool, then flushes the OTel SDK. It never calls `process.exit`: the
 * process ends when its handles drain.
 */
import { realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { startTelemetry } from './telemetry.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface RunningServer {
  readonly host: string;
  /** The bound port (`PORT=0` asks the OS for one). */
  readonly port: number;
  /** Closes the listener, then every pool. Idempotent. */
  close(): Promise<void>;
}

const DEFAULT_HOST = '0.0.0.0';

function parsePort(raw: string | undefined): number {
  if (raw === undefined || !/^\d{1,5}$/.test(raw)) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  const port = Number(raw);
  if (port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  return port;
}

export async function start(env: Env): Promise<RunningServer> {
  // Validate before any pool is built.
  const port = parsePort(env['PORT']);
  const host = env['HOST'] === undefined || env['HOST'] === '' ? DEFAULT_HOST : env['HOST'];

  // The SDK starts before the app is built so instrumentation sees every import.
  const telemetry = startTelemetry(env);
  let built: Awaited<ReturnType<typeof import('./bootstrap.js').createAppFromEnv>>;
  try {
    // Imported after the SDK starts, so `http` and `pg` are patched on first load.
    const { createAppFromEnv } = await import('./bootstrap.js');
    built = await createAppFromEnv(env);
  } catch (error) {
    await telemetry?.shutdown();
    throw error;
  }
  try {
    await built.app.listen({ host, port });
  } catch (error) {
    await built.close();
    await telemetry?.shutdown();
    throw error;
  }
  const address = built.app.server.address() as AddressInfo;

  let closing: Promise<void> | undefined;
  const onSignal = (): void => {
    void close().catch(() => undefined);
  };
  function close(): Promise<void> {
    closing ??= (async () => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      await built.close();
      await telemetry?.shutdown();
    })();
    return closing;
  }
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return { host, port: address.port, close };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  start(process.env).catch((error: unknown) => {
    // Only the message: never the stack or the environment.
    process.stderr.write(
      `startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
