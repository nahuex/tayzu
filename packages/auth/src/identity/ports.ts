/**
 * Structural ports of the identity code (`043` design D2 and Q30), implemented
 * in `apps/api` so that `@tayzu/auth` depends on neither `@orpc/server` nor
 * `@tayzu/catalog`.
 */

/**
 * Sheds the SSO links a user did not make when they hold a second tenant
 * (task 8.5h, design D4 step 7). `afterAddMember` calls it before its `_user`
 * write; a rejection fails the hook, so the new membership stays inert.
 */
export interface SsoLinkShedPort {
  shed(input: { readonly tenantId: string; readonly userId: string }): Promise<void>;
}
