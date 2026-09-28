/**
 * @tayzu/auth: Better Auth instance, schema and context resolver.
 */
export { createAuth, type AuthInstance, type CreateAuthOptions } from './auth.js';
export {
  createContextResolver,
  type ContextResolver,
  type ContextResolverOptions,
  type ResolvedActor,
  type ResolvedContext,
} from './context-resolver.js';
export { AuthContextError } from './errors.js';
