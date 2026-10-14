/**
 * Task 8.5h (043 Resolved decision Q86, design D13): `@tayzu/auth` exports
 * `emitSessionRevoked` from its index with the reason as a parameter
 * (`password_change`, `admin_action` or `sso_link_shed`), so that the shed, the
 * admin unlink (8.5j) and the admin revocation (11.2) emit the same event the
 * `password_change` revocation of `002` already does.
 *
 * The `password_change` revocation of `/change-password` keeps emitting its
 * reason unchanged: that is asserted over real HTTP by `session-policy.int.test.ts`
 * ("Password change revokes other sessions"), whose expectation of the exact
 * attribute set this task does not change.
 *
 * ## Production symbols expected
 *
 * - `emitSessionRevoked({ actorId, tenantId?, reason })` exported from
 *   `packages/auth/src/index.ts` (defined in `auth.ts`, where it is private today
 *   with its reason fixed to `password_change`). It emits the log event
 *   `auth.security.session_revoked` at INFO with `tayzu.actor.id`,
 *   `tayzu.tenant.id` (only when given) and `tayzu.auth.revocation.reason`, and
 *   adds 1 to the session events counter.
 *
 * ## Why this fails right now
 *
 * `emitSessionRevoked` is not exported from the index.
 */
// Load-bearing import order (design D1): the harness registers before the
// module that creates the logger loads.
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { beforeEach, describe, expect, it } from 'vitest';

import * as authPackage from './index.js';

type Reason = 'password_change' | 'admin_action' | 'sso_link_shed';

type EmitSessionRevoked = (params: {
  readonly actorId: string;
  readonly tenantId?: string;
  readonly reason: Reason;
}) => void;

function harnessOf(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(`telemetry harness failed to register: ${String(registration.error)}`, {
      cause: registration.error,
    });
  }
  return registration.harness;
}

function emitter(): EmitSessionRevoked {
  const candidate = (authPackage as Record<string, unknown>)['emitSessionRevoked'];
  if (typeof candidate !== 'function') {
    throw new Error('@tayzu/auth does not export emitSessionRevoked');
  }
  return candidate as EmitSessionRevoked;
}

async function revokedRecords() {
  const harness = harnessOf();
  await harness.forceFlush();
  return [...harness.logExporter.getFinishedLogRecords()].filter(
    (record) => record.eventName === 'auth.security.session_revoked',
  );
}

describe('emitSessionRevoked (task 8.5h)', () => {
  beforeEach(async () => {
    await harnessOf().reset();
  });

  it('is exported from the package index as a function', () => {
    expect(typeof (authPackage as Record<string, unknown>)['emitSessionRevoked']).toBe('function');
  });

  it.each<Reason>(['password_change', 'admin_action', 'sso_link_shed'])(
    'emits auth.security.session_revoked with the reason %s it is given',
    async (reason) => {
      emitter()({ actorId: 'user-1', tenantId: 'tenant-1', reason });

      const records = await revokedRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.severityNumber).toBe(SeverityNumber.INFO);
      expect(records[0]?.attributes).toEqual({
        'tayzu.tenant.id': 'tenant-1',
        'tayzu.actor.id': 'user-1',
        'tayzu.auth.revocation.reason': reason,
      });
    },
  );

  it('omits the tenant attribute when none is given', async () => {
    emitter()({ actorId: 'user-2', reason: 'sso_link_shed' });

    const records = await revokedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.attributes).toEqual({
      'tayzu.actor.id': 'user-2',
      'tayzu.auth.revocation.reason': 'sso_link_shed',
    });
  });

  it('emits one event per call', async () => {
    emitter()({ actorId: 'user-3', reason: 'sso_link_shed' });
    emitter()({ actorId: 'user-3', reason: 'sso_link_shed' });

    expect(await revokedRecords()).toHaveLength(2);
  });
});
