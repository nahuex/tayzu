/**
 * Scope-generic bucket store on `002`'s DB-backed atomic rate limiter
 * (task 6.10 of change 043; `auth.rate_limit`, hashed keys, no migration).
 * Windows follow `002`'s store semantics (Resolved decision Q66).
 */
import type { DBAdapter } from 'better-auth/types';

import {
  consumeRateLimitBucket,
  emitRateLimited,
  hashBucketKey,
  type BucketKeyKind,
  type ConsumeResult,
  type RateLimitRuleOptions,
  type RateLimitScope,
} from './pre-auth-rate-limit.js';

export interface RateLimitBucketStoreOptions {
  /** `(await auth.$context).adapter`. */
  readonly adapter: DBAdapter;
  /** The rule of every scope this store accepts; any other scope is refused. */
  readonly rules: Readonly<Partial<Record<RateLimitScope, RateLimitRuleOptions>>>;
}

export interface RateLimitBucketStore {
  /** Records one hit; throws for a scope without a rule, creating no row. */
  consume(bucket: {
    readonly scope: string;
    readonly kind: string;
    readonly value: string;
  }): Promise<ConsumeResult>;
}

export function createRateLimitBucketStore(
  options: RateLimitBucketStoreOptions,
): RateLimitBucketStore {
  const rules = new Map(Object.entries(options.rules));
  return {
    async consume({ scope, kind, value }) {
      const rule = rules.get(scope);
      if (rule === undefined) {
        throw new Error('Unknown rate-limit scope.');
      }
      const key = hashBucketKey(scope as RateLimitScope, kind as BucketKeyKind, value);
      const result = await consumeRateLimitBucket(options.adapter, key, rule);
      if (!result.allowed) {
        emitRateLimited(scope as RateLimitScope);
      }
      return result;
    },
  };
}
