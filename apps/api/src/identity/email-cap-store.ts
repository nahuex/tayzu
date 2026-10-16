/**
 * The email caps on the shared DB-backed bucket store (`043` design D4 "Invitation email
 * caps", Resolved decisions Q101 and Q138; task 14.12). Each scope the gate and the notice
 * dispatcher use maps onto one bucket of `002`'s `auth.rate_limit`, so the count is shared
 * across replicas and every key is stored only as a hash.
 */
import { AuthRateLimitedError, type RateLimitBucketStore } from '@tayzu/auth';

import type { EmailCapStore } from './email-tenant-gate.js';

const BUCKETS: Readonly<Record<string, { readonly scope: string; readonly kind: string }>> = {
  __proto__: null as never,
  tenant: { scope: 'invitation_tenant', kind: 'tenant' },
  recipient: { scope: 'invitation_recipient', kind: 'email' },
  notice_tenant: { scope: 'notice_tenant', kind: 'tenant' },
  notice_recipient: { scope: 'notice_recipient', kind: 'email' },
  // Change 044 (task 4.3, design D16): the reset and recovery buckets.
  reset_recipient: { scope: 'reset_email_recipient', kind: 'email' },
  reset_ip: { scope: 'reset_email_ip', kind: 'ip' },
  reset_global: { scope: 'reset_email_global', kind: 'global' },
  recovery_notice_recipient: { scope: 'recovery_notice_recipient', kind: 'email' },
  account_created_tenant: { scope: 'account_created_notice_tenant', kind: 'tenant' },
  account_created_global: { scope: 'account_created_notice_global', kind: 'global' },
};

export function createDbEmailCapStore(options: {
  readonly store: RateLimitBucketStore;
}): EmailCapStore {
  return {
    async consume(scope, key) {
      const bucket = BUCKETS[scope];
      if (bucket === undefined) {
        throw new Error('Unsupported email cap scope.');
      }
      const result = await options.store.consume({ ...bucket, value: key });
      if (!result.allowed) {
        throw new AuthRateLimitedError(result.retryAfterSeconds ?? 1);
      }
    },
  };
}
