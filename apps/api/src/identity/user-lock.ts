/**
 * One Postgres advisory lock per user id (`043` task 8.5i, Resolved decisions Q87
 * and Q114). It serializes linking an SSO account against joining a tenant for one
 * user, and lets two different users run in parallel.
 */
import type { Pool, PoolClient } from 'pg';

export type WithUserLock = <T>(userId: string, fn: (tx: PoolClient) => Promise<T>) => Promise<T>;

/**
 * Binds the lock to the `tayzu_auth` pool. Each call opens one short dedicated
 * transaction, takes `pg_advisory_xact_lock` on a 64-bit key hashed from the user id
 * (a bound parameter, never interpolated), runs `fn` on that transaction and commits.
 * The lock is released when the transaction ends, so a failing `fn` rolls back.
 */
export function createWithUserLock(authPool: Pool): WithUserLock {
  return async (userId, fn) => {
    const client = await authPool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}
