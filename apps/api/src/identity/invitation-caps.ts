/**
 * The invitation email caps (`043` design D5, Resolved decision Q15). The tenant cap is
 * 30 emails per hour, shared by invite and resend because both go through the one gate
 * and the one store. The recipient cap (6.7, 3 per 24 hours across tenants) is a second bucket; the kill switch (6.8) add to this file.
 */
import { AuthRateLimitedError } from '@tayzu/auth';

import type { EmailCapStore } from './email-tenant-gate.js';

interface CapLimit {
  readonly max: number;
  readonly windowSeconds: number;
}

export interface InvitationCapLimits {
  readonly tenant: CapLimit;
  readonly recipient: CapLimit;
}

interface Bucket {
  count: number;
  resetAtMs: number;
}

/** An in-memory fixed-window store; `consume` rejects once the tenant's bucket is full. */
export function createInMemoryEmailCapStore(limits: InvitationCapLimits): EmailCapStore {
  const buckets = new Map<string, Bucket>();
  return {
    consume(scope, key) {
      if (scope !== 'tenant' && scope !== 'recipient') {
        return Promise.reject(new Error(`Unsupported email cap scope: ${scope}`));
      }
      const { max, windowSeconds } = limits[scope];
      const now = Date.now();
      const bucketKey = `${scope}:${key}`;
      let bucket = buckets.get(bucketKey);
      if (bucket === undefined || bucket.resetAtMs <= now) {
        bucket = { count: 0, resetAtMs: now + windowSeconds * 1000 };
        buckets.set(bucketKey, bucket);
      }
      if (bucket.count >= max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000));
        return Promise.reject(new AuthRateLimitedError(retryAfterSeconds));
      }
      bucket.count += 1;
      return Promise.resolve();
    },
  };
}
