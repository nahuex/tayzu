/**
 * Break-glass reset of a member's second factor (`044` design D12, Resolved decisions Q14-Q16).
 * `recoverAdminMfa` resolves the organization and the user, then runs the shared service of
 * `src/identity/mfa-reset.ts` in operator form on the `tayzu_auth` pool. The CLI holds no
 * `BETTER_AUTH_SECRET`, no cap store and no mailer: its one notice goes through the sender.
 * It prints nothing; the completion line and the telemetry guard are task 11.3's.
 */
import { parseArgs } from 'node:util';

import type { EmailSender } from '@tayzu/auth';
import type { Pool } from 'pg';

import { createEmailSender } from '../src/email-sender.js';
import { canonicalEmail } from '../src/identity/email-canonical.js';
import { createAuthRepository } from '../src/identity/auth-repository.js';
import {
  createMfaResetService,
  type NoticeOutcome,
  type RecoveryNoticePort,
} from '../src/identity/mfa-reset.js';
import { loadScriptConfig, OPERATOR_ID_PATTERN } from './script-config.js';

export interface RecoverAdminMfaOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The command line after the script name. */
  readonly args: readonly string[];
  /** The `tayzu_auth` pool; the host built it and this function does not end it. */
  readonly authPool: Pool;
  /** Test seam: defaults to the sender the environment selects. */
  readonly sender?: EmailSender;
}

export interface RecoverAdminMfaResult {
  readonly userId: string;
  readonly sessionsRevoked: number;
  readonly notice: NoticeOutcome;
}

/** Fixed text for every refusal about the target: it says nothing about which check failed. */
class TargetRefusedError extends Error {
  constructor() {
    super('The organization or the user was not found.');
    this.name = 'TargetRefusedError';
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** The `RecoveryNoticePort` of the CLI: the sender behind the kill switch and the disabled tenants. */
function createSenderNoticePort(deps: {
  readonly authPool: Pool;
  readonly sender: EmailSender;
  readonly killSwitch: boolean;
  readonly disabledTenantIds: readonly string[];
}): RecoveryNoticePort {
  const repository = createAuthRepository(deps.authPool);
  const disabled = new Set(deps.disabledTenantIds);
  return {
    async send(kind, userId) {
      try {
        if (deps.killSwitch) return 'suppressed';
        const tenantIds = await repository.globalMembershipTenantsOf(userId);
        if (tenantIds.every((id) => disabled.has(id))) return 'suppressed';
        const user = await repository.globalUserById(userId);
        if (user === undefined) return 'failed';
        await deps.sender.send(user.email, { kind });
        return 'sent';
      } catch {
        return 'failed';
      }
    },
  };
}

export async function recoverAdminMfa(
  options: RecoverAdminMfaOptions,
): Promise<RecoverAdminMfaResult> {
  const { values } = parseArgs({
    args: [...options.args],
    options: {
      'organization-slug': { type: 'string' },
      email: { type: 'string' },
      approver: { type: 'string' },
    },
    strict: true,
  });
  const config = loadScriptConfig('recover-admin-mfa', options.env);
  const operatorId = config.TAYZU_OPERATOR_ID;
  const approverId = values.approver;
  if (approverId === undefined || !OPERATOR_ID_PATTERN.test(approverId)) {
    throw new Error('--approver is required and must be an opaque id.');
  }
  if (approverId === operatorId) {
    throw new Error('--approver must differ from the operator id.');
  }
  const slug = values['organization-slug'];
  const email = values.email;
  if (slug === undefined || slug === '' || email === undefined || email === '') {
    throw new Error('--organization-slug and --email are required.');
  }

  const sender =
    options.sender ??
    createEmailSender({
      ...(config.EMAIL_PROVIDER === 'acs' || config.EMAIL_PROVIDER === 'none'
        ? { emailProvider: config.EMAIL_PROVIDER }
        : {}),
      ...(config.ACS_CONNECTION_STRING === undefined
        ? {}
        : { acsConnectionString: config.ACS_CONNECTION_STRING }),
      ...(config.EMAIL_SENDER_ADDRESS === undefined
        ? {}
        : { emailSenderAddress: config.EMAIL_SENDER_ADDRESS }),
      emailRecipientDomainAllowlist: splitList(config.EMAIL_RECIPIENT_DOMAIN_ALLOWLIST),
    });

  const repository = createAuthRepository(options.authPool);
  const organization = await options.authPool.query<{ id: string }>(
    'select id from auth.organization where slug = $1',
    [slug],
  );
  const tenantId = organization.rows[0]?.id;
  const user = await repository.globalUserByEmail(canonicalEmail(email));
  if (tenantId === undefined || user === undefined) throw new TargetRefusedError();
  if ((await repository.memberOf(tenantId, user.id)) === undefined) throw new TargetRefusedError();

  const service = createMfaResetService({
    authPool: options.authPool,
    notices: createSenderNoticePort({
      authPool: options.authPool,
      sender,
      killSwitch: config.INVITATION_EMAIL_KILL_SWITCH === 'true',
      disabledTenantIds: splitList(config.EMAIL_DISABLED_TENANT_IDS),
    }),
  });
  const result = await service.resetOperator({
    tenantId,
    operatorId,
    approverId,
    userId: user.id,
  });
  return { userId: user.id, ...result };
}
