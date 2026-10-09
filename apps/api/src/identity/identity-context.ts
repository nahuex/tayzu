/**
 * The ambient identity context (`043` design D2, Resolved decision Q117).
 * Better Auth's `afterAddMember` hook receives only `{ member, user,
 * organization }`, so an identity operation hands the acting admin to the hook
 * by running its in-process `auth.api` call inside this store. The hook lives
 * in `@tayzu/auth` and never reads it: the `UserSyncPort` adapter of this app
 * does.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface IdentityContext {
  /** The Better Auth user id of the acting admin. */
  readonly adminId: string;
}

const store = new AsyncLocalStorage<IdentityContext>();

/** Runs `fn` with `context` visible to every write it triggers. */
export function runWithIdentityContext<T>(
  context: IdentityContext,
  fn: () => Promise<T>,
): Promise<T> {
  return store.run(context, fn);
}

/** The context of the running operation, if any. */
export function currentIdentityContext(): IdentityContext | undefined {
  return store.getStore();
}
