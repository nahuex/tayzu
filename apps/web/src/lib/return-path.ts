/**
 * Return paths (design D15, D12 and Q65; scenario "An external return path
 * is ignored").
 *
 * A `returnTo` value or the stored step-up path is kept only when it is an
 * in-app path of a signed-in route: `/`, `/catalog/$blueprint`,
 * `/catalog/$blueprint/$entity` or `/search`, with an optional query and no
 * fragment. Anything else becomes `/`, so sign-in and step-up are never open
 * redirects. The public and gate pages are never return targets.
 */

const FALLBACK = '/';

const MAX_LENGTH = 2048;

/** C0 controls, DEL and C1 controls. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** The catalog's blueprint identifier rule (`packages/catalog/src/domain/identifiers.ts`). */
const BLUEPRINT_SEGMENT = /^_?[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * The catalog's entity identifier rule, without `/`: an identifier with `/`
 * is never put in a URL (D13).
 */
const ENTITY_SEGMENT = /^[A-Za-z0-9@_.:=-]{1,256}$/;

/** True when the path part (no query) is a signed-in route. */
function isSignedInRoute(path: string): boolean {
  if (path === '/') return true;
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return false;
  const [first, blueprint, entity, ...rest] = segments;
  if (first === 'search') return segments.length === 1;
  if (first !== 'catalog' || blueprint === undefined || rest.length > 0) return false;
  if (!BLUEPRINT_SEGMENT.test(blueprint)) return false;
  return entity === undefined || ENTITY_SEGMENT.test(entity);
}

/** True when `value` resolves to a path on the page's own origin. */
function isSameOrigin(value: string): boolean {
  try {
    const origin = window.location.origin;
    return new URL(value, origin).origin === origin;
  } catch {
    return false;
  }
}

/** Returns `value` when it is a valid in-app return path, and `/` otherwise. Never throws. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return FALLBACK;
  if (CONTROL_CHARACTER.test(value) || value.includes('\\')) return FALLBACK;
  if (!value.startsWith('/') || value.includes('//') || value.includes('#')) return FALLBACK;

  const queryStart = value.indexOf('?');
  const path = queryStart === -1 ? value : value.slice(0, queryStart);
  if (path.includes('%')) return FALLBACK;

  return isSignedInRoute(path) && isSameOrigin(value) ? value : FALLBACK;
}
