/**
 * Task 11.3 of openspec/changes/044-password-reset-and-account-recovery (design D12, Resolved
 * decisions Q29 and Q31): the evidence and the telemetry guard of `scripts/recover-admin-mfa.ts`.
 *
 * Scenarios of `specs/password-reset-and-account-recovery/spec.md`, requirement "Operator recovery
 * covers every target the admin operation does not":
 *
 * - "The command refuses to run without telemetry": GIVEN any value of `NODE_ENV`, including
 *   `test`; WHEN the entry point starts with `TAYZU_TELEMETRY_DISABLED=true`, or with no OTLP
 *   endpoint set; THEN it exits non-zero before any database or email work and changes nothing.
 * - "A failed telemetry flush fails the run": WHEN the final telemetry flush of a completed run
 *   fails; THEN the command exits non-zero with a fixed message that says the audit event may be
 *   missing, and the completion line was already printed.
 * - "The command prints one completion line": WHEN the command completes; THEN it prints exactly
 *   one line holding the operator id, the approver id, the target's opaque user id, the number of
 *   sessions revoked and whether the notice was sent, suppressed or failed, and no address and no
 *   secret.
 * - "The completion line reports a failed notice": WHEN the command completes and the email
 *   provider fails on the notice; THEN the run still completes and the line says the notice
 *   failed.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/scripts/recover-admin-mfa.ts
 * export interface RecoverAdminMfaCliOptions {
 *   readonly env?: Readonly<Record<string, string | undefined>>; // default process.env
 *   readonly args?: readonly string[];                           // default process.argv.slice(2)
 *   readonly authPool?: Pool;     // when given, main() does not end it (as bootstrap-admin's main)
 *   readonly sender?: EmailSender; // test seam, as RecoverAdminMfaOptions.sender
 *   readonly telemetry?: Telemetry; // forwarded to runScript's RunScriptOptions.telemetry
 * }
 * // The entry point. It applies the telemetry guard FIRST (before any pool, role check, database
 * // or email work), builds the pool from AUTH_DATABASE_URL when none is given, runs
 * // runScript('recover-admin-mfa', ...) with roles [{ pool, roles: ['tayzu_auth'] }] and prints
 * // the completion line inside the callback. It rejects on a refused start (message names
 * // TAYZU_TELEMETRY_DISABLED or the OTLP endpoint) and on a failed flush (fixed message that says
 * // the audit event may be missing). The `if (isEntryPoint())` block turns a rejection into
 * // `process.exitCode = 1` plus a stderr line, as bootstrap-admin.ts does.
 * export function main(options?: RecoverAdminMfaCliOptions): Promise<void>;
 *
 * // apps/api/scripts/run-script.ts
 * export interface RunScriptOptions {
 *   readonly telemetry?: Telemetry; // when present, replaces startTelemetry(env)
 * }
 *
 * // apps/api/src/telemetry.ts: the endpoint list becomes one exported helper shared by
 * // startTelemetry and the guard (its name is the implementer's; the tests do not import it).
 * ```
 *
 * The guard tests never read `process.env`: the environment is injected, with `NODE_ENV=test`.
 * Because `startTelemetry` returns `undefined` under test, every test supplies the telemetry
 * handle through the seam. One extra case spawns the real entry point to observe a real exit code.
 *
 * Harness: the shared test database, random ids per test; the command touches only its target.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createRecordingEmailSender, type EmailSender } from '@tayzu/auth';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { getOwnerPool } from '../../../packages/db/src/harness.js';
import { main } from '../scripts/recover-admin-mfa.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(here, '../scripts/recover-admin-mfa.ts');
const API_ROOT = resolve(here, '..');

const COMPLETION_LINE =
  /^mfa-reset operator=(\S+) approver=(\S+) user=(\S+) sessions_revoked=(\d+) notice=(sent|suppressed|failed)$/;
const CONNECTION_STRING = /postgres(ql)?:\/\//i;

/** A pool whose every connection runs as `tayzu_auth` (a fixed literal, never input). */
function poolAsAuth(): Pool {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('connect', (client) => {
    void client.query('SET ROLE tayzu_auth').catch(() => undefined);
  });
  pool.on('error', () => undefined);
  return pool;
}

/** Counts every use of a pool (and of the clients it hands out). */
function countUses(pool: Pool, onUse: () => void): Pool {
  type Fn = (...args: unknown[]) => unknown;
  const spyOnClient = (client: unknown): unknown =>
    new Proxy(client as object, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query') {
          return (...args: unknown[]): unknown => {
            onUse();
            return (value as Fn).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as Fn).bind(target) : value;
      },
    });
  return new Proxy(pool, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'query') {
        return (...args: unknown[]): unknown => {
          onUse();
          return (value as Fn).apply(target, args);
        };
      }
      if (property === 'connect') {
        return async (): Promise<unknown> => {
          onUse();
          return spyOnClient(await target.connect());
        };
      }
      return typeof value === 'function' ? (value as Fn).bind(target) : value;
    },
  });
}

describe('The recover-admin-mfa evidence and telemetry guard (task 11.3, design D12, Q29, Q31)', () => {
  let ownerPool: Pool;
  let authPool: Pool;
  const operatorId = `op-${randomUUID()}`;

  beforeAll(async () => {
    ownerPool = await getOwnerPool();
    authPool = poolAsAuth();
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await authPool.end();
  });

  // ---- output capture --------------------------------------------------------------------

  function captureOutput(): {
    readonly stdout: () => string[];
    readonly stderr: () => string[];
  } {
    const toText = (chunk: unknown): string =>
      typeof chunk === 'string'
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString()
          : '';
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      err.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      err.push(args.map(String).join(' '));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(toText(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err.push(toText(chunk));
      return true;
    });
    const lines = (chunks: string[]): string[] =>
      chunks
        .join('\n')
        .split('\n')
        .filter((line) => line.trim() !== '');
    return { stdout: () => lines(out), stderr: () => lines(err) };
  }

  // ---- seeds -----------------------------------------------------------------------------

  interface Seeded {
    readonly tenantId: string;
    readonly slug: string;
    readonly userId: string;
    readonly email: string;
  }

  async function seedTarget(sessions: number): Promise<Seeded> {
    const tenantId = `org-${randomUUID()}`;
    const slug = `evidence-${randomUUID()}`;
    const userId = `usr-${randomUUID()}`;
    const email = `evidence-${randomUUID()}@example.test`;
    await ownerPool.query(
      'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
      [tenantId, 'Org', slug],
    );
    await ownerPool.query(
      'insert into auth."user" (id, name, email, email_verified, created_at, updated_at, two_factor_enabled) values ($1, $2, $3, true, now(), now(), true)',
      [userId, 'User', email],
    );
    await ownerPool.query(
      'insert into auth.member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, $4, now())',
      [`mem-${randomUUID()}`, tenantId, userId, 'admin'],
    );
    const factorId = `tf-${randomUUID()}`;
    await ownerPool.query(
      `insert into auth.two_factor (id, secret, backup_codes, user_id, verified, failed_verification_count)
       values ($1, $2, $3, $4, true, 0)`,
      [factorId, `enc-secret-${factorId}`, `enc-codes-${factorId}`, userId],
    );
    for (let index = 0; index < sessions; index += 1) {
      await ownerPool.query(
        `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
         values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
        [`ses-${randomUUID()}`, `tok-${randomUUID()}`, userId, tenantId],
      );
    }
    return { tenantId, slug, userId, email };
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const result = await ownerPool.query<{ n: string }>(`select count(*) as n ${sql}`, params);
    return Number(result.rows[0]?.n);
  }

  async function expectUntouched(target: Seeded, sessions: number): Promise<void> {
    expect(await count('from auth.two_factor where user_id = $1', [target.userId])).toBe(1);
    expect(await count('from auth.session where user_id = $1', [target.userId])).toBe(sessions);
    expect(
      await count('from auth.verification where identifier = $1', [`mfa-reenrol:${target.userId}`]),
    ).toBe(0);
  }

  // ---- the environment and the arguments -------------------------------------------------

  /** A start the guard accepts: an OTLP endpoint set, the opt-out absent, `NODE_ENV=test`. */
  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      NODE_ENV: 'test',
      AUTH_DATABASE_URL: process.env.DATABASE_URL ?? '',
      TAYZU_OPERATOR_ID: operatorId,
      EMAIL_PROVIDER: 'none',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      ...extra,
    };
  }

  function argsFor(target: Seeded, approver: string): string[] {
    return ['--organization-slug', target.slug, '--email', target.email, '--approver', approver];
  }

  const newApprover = (): string => `appr-${randomUUID()}`;

  const okTelemetry = (): { shutdown: ReturnType<typeof vi.fn<() => Promise<void>>> } => ({
    shutdown: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  });

  const throwingSender: EmailSender = {
    send: () => Promise.reject(new Error('provider down: smtp user@secret.example')),
  };

  // ---- "The command refuses to run without telemetry" ------------------------------------

  describe('The command refuses to run without telemetry', () => {
    async function expectRefusedBeforeAnyWork(
      environment: Record<string, string | undefined>,
    ): Promise<void> {
      const output = captureOutput();
      const target = await seedTarget(1);
      const sender = createRecordingEmailSender();
      const telemetry = okTelemetry();
      let uses = 0;
      const pool = countUses(authPool, () => {
        uses += 1;
      });

      await expect(
        main({
          env: environment,
          args: argsFor(target, newApprover()),
          authPool: pool,
          sender,
          telemetry,
        }),
      ).rejects.toBeInstanceOf(Error);

      expect(uses, 'no database work').toBe(0);
      expect(sender.sent, 'nothing sent').toHaveLength(0);
      await expectUntouched(target, 1);
      expect(
        output.stdout().filter((line) => COMPLETION_LINE.test(line)),
        'no completion line',
      ).toHaveLength(0);
    }

    it('refuses with TAYZU_TELEMETRY_DISABLED=true even with an endpoint set and NODE_ENV=test', async () => {
      await expectRefusedBeforeAnyWork(env({ TAYZU_TELEMETRY_DISABLED: 'true' }));
    }, 60_000);

    it('refuses with no OTLP endpoint variable set and NODE_ENV=test', async () => {
      const withoutEndpoint: Record<string, string | undefined> = env();
      delete withoutEndpoint['OTEL_EXPORTER_OTLP_ENDPOINT'];
      await expectRefusedBeforeAnyWork(withoutEndpoint);
    }, 60_000);

    it('refuses with an empty endpoint value', async () => {
      await expectRefusedBeforeAnyWork(env({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }));
    }, 60_000);

    it('accepts a start with only a per-signal endpoint set (the guard shares the endpoint list)', async () => {
      captureOutput();
      const target = await seedTarget(1);
      const withSignalEndpoint: Record<string, string | undefined> = env();
      delete withSignalEndpoint['OTEL_EXPORTER_OTLP_ENDPOINT'];
      withSignalEndpoint['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = 'http://127.0.0.1:1/v1/traces';

      await main({
        env: withSignalEndpoint,
        args: argsFor(target, newApprover()),
        authPool,
        sender: createRecordingEmailSender(),
        telemetry: okTelemetry(),
      });

      expect(await count('from auth.two_factor where user_id = $1', [target.userId])).toBe(0);
    }, 60_000);

    it('the real entry point exits non-zero with a telemetry message before any database work, whatever NODE_ENV says', async () => {
      const target = await seedTarget(1);
      const childEnv: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        TAYZU_TELEMETRY_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
        AUTH_DATABASE_URL: process.env.DATABASE_URL ?? '',
        TAYZU_OPERATOR_ID: operatorId,
        EMAIL_PROVIDER: 'none',
      };

      const outcome = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', SCRIPT_PATH, ...argsFor(target, newApprover())],
        { cwd: API_ROOT, env: childEnv, timeout: 90_000 },
      ).then(
        () => ({ code: 0, stdout: '', stderr: '' }),
        (error: unknown) => {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          return {
            code: failure.code ?? 1,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? '',
          };
        },
      );

      expect(outcome.code, 'non-zero exit').not.toBe(0);
      expect(outcome.stderr).toMatch(/telemetry|OTLP|OTEL_EXPORTER/i);
      expect(outcome.stdout.trim(), 'nothing on stdout').toBe('');
      await expectUntouched(target, 1);
    }, 120_000);
  });

  // ---- "The command prints one completion line" ------------------------------------------

  describe('The command prints one completion line', () => {
    it('prints exactly one line with the operator, the approver, the opaque user id, the count and the notice state, and no address or secret', async () => {
      const output = captureOutput();
      const target = await seedTarget(2);
      const approver = newApprover();
      const telemetry = okTelemetry();

      await main({
        env: env(),
        args: argsFor(target, approver),
        authPool,
        sender: createRecordingEmailSender(),
        telemetry,
      });

      const stdout = output.stdout();
      expect(stdout, 'exactly one line on stdout').toHaveLength(1);
      const line = stdout[0] ?? '';
      const match = COMPLETION_LINE.exec(line);
      expect(match, `the line matches the pattern: ${line}`).not.toBeNull();
      expect(line).toBe(
        `mfa-reset operator=${operatorId} approver=${approver} user=${target.userId} sessions_revoked=2 notice=sent`,
      );
      expect(line).not.toContain(target.email);
      expect(line).not.toContain('@');
      expect(telemetry.shutdown, 'the telemetry handle is flushed once').toHaveBeenCalledTimes(1);
    }, 60_000);

    it('reports suppressed when the kill switch is on', async () => {
      const output = captureOutput();
      const target = await seedTarget(1);
      const sender = createRecordingEmailSender();

      await main({
        env: env({ INVITATION_EMAIL_KILL_SWITCH: 'true' }),
        args: argsFor(target, newApprover()),
        authPool,
        sender,
        telemetry: okTelemetry(),
      });

      expect(output.stdout()).toHaveLength(1);
      expect(output.stdout()[0]).toMatch(/ sessions_revoked=1 notice=suppressed$/);
      expect(sender.sent).toHaveLength(0);
    }, 60_000);

    it('neither stdout nor stderr holds an email address, a token, a password or a connection string', async () => {
      const output = captureOutput();
      const target = await seedTarget(1);
      const secrets = ['super-secret-acs-key', 'supersecretpassword'];

      await main({
        env: env({
          ACS_CONNECTION_STRING: `endpoint=https://acs.example/;accesskey=${secrets[0] ?? ''}`,
          AUTH_DATABASE_URL: `postgres://tayzu_auth:${secrets[1] ?? ''}@${new URL(process.env.DATABASE_URL ?? 'postgres://x@localhost/db').host}/db`,
        }),
        args: argsFor(target, newApprover()),
        authPool,
        sender: throwingSender,
        telemetry: okTelemetry(),
      });

      const everything = [...output.stdout(), ...output.stderr()].join('\n');
      expect(everything).not.toContain(target.email);
      expect(everything).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      expect(everything).not.toMatch(CONNECTION_STRING);
      expect(everything).not.toContain('accesskey');
      for (const secret of secrets) expect(everything).not.toContain(secret);
      expect(everything).not.toMatch(/token|password/i);
    }, 60_000);
  });

  // ---- "The completion line reports a failed notice" -------------------------------------

  describe('The completion line reports a failed notice', () => {
    it('completes when the sender throws and the line ends notice=failed, with the reset done', async () => {
      const output = captureOutput();
      const target = await seedTarget(1);

      await main({
        env: env(),
        args: argsFor(target, newApprover()),
        authPool,
        sender: throwingSender,
        telemetry: okTelemetry(),
      });

      const stdout = output.stdout();
      expect(stdout).toHaveLength(1);
      expect(stdout[0]).toMatch(COMPLETION_LINE);
      expect(stdout[0]).toMatch(/ notice=failed$/);
      expect(stdout[0]).toContain(`user=${target.userId} sessions_revoked=1`);
      expect(await count('from auth.two_factor where user_id = $1', [target.userId])).toBe(0);
      expect(JSON.stringify([stdout, output.stderr()])).not.toContain('smtp');
    }, 60_000);
  });

  // ---- "A failed telemetry flush fails the run" ------------------------------------------

  describe('A failed telemetry flush fails the run', () => {
    it('rejects with a fixed message that says the audit event may be missing, with the completion line already on stdout and the reset committed', async () => {
      const output = captureOutput();
      const target = await seedTarget(1);
      const approver = newApprover();
      const telemetry = {
        shutdown: vi.fn<() => Promise<void>>(() =>
          Promise.reject(new Error('export failed: https://collector.internal:4318 key=abc123')),
        ),
      };

      const failure = await main({
        env: env(),
        args: argsFor(target, approver),
        authPool,
        sender: createRecordingEmailSender(),
        telemetry,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure, 'the run fails').toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : '';
      expect(message).toMatch(/audit event/i);
      expect(message).toMatch(/missing/i);
      expect(message, 'the message is fixed text, not the exporter error').not.toContain(
        'collector',
      );
      expect(message).not.toContain('abc123');
      expect(telemetry.shutdown).toHaveBeenCalledTimes(1);

      const stdout = output.stdout();
      expect(stdout, 'the completion line was already printed').toHaveLength(1);
      expect(stdout[0]).toBe(
        `mfa-reset operator=${operatorId} approver=${approver} user=${target.userId} sessions_revoked=1 notice=sent`,
      );
      expect(await count('from auth.two_factor where user_id = $1', [target.userId])).toBe(0);
    }, 60_000);
  });
});
