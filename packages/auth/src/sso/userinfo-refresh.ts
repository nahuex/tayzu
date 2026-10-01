/**
 * JIT display-data refresh on Visma Connect sign-in (task 21.1, design D24).
 *
 * Calls the provider's userinfo endpoint (found through OIDC discovery) with
 * the fresh access token and returns the `name` / `email` it reports. The
 * caller writes them to the `_user` entity's display fields only; nothing here
 * touches Better Auth's core `user.email`, and the values never reach logs,
 * spans or errors. A failed lookup returns `null`: a transient userinfo
 * failure must not block the sign-in itself.
 */

/** The display data Visma Connect reports for a `sub`. */
export interface VismaUserInfo {
  readonly name?: string;
  readonly email?: string;
}

const USERINFO_TIMEOUT_MS = 5_000;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Reads `userinfo_endpoint` from the discovery document. */
async function discoverUserInfoEndpoint(discoveryUrl: string): Promise<string | undefined> {
  const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS) });
  if (!response.ok) {
    return undefined;
  }
  const document = (await response.json()) as { userinfo_endpoint?: unknown };
  return nonEmptyString(document.userinfo_endpoint);
}

/** Fetches the caller's display data, or `null` on any failure. */
export async function fetchVismaUserInfo(
  discoveryUrl: string,
  accessToken: string,
): Promise<VismaUserInfo | null> {
  try {
    const endpoint = await discoverUserInfoEndpoint(discoveryUrl);
    if (endpoint === undefined) {
      return null;
    }
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { name?: unknown; email?: unknown };
    const name = nonEmptyString(body.name);
    const email = nonEmptyString(body.email);
    return {
      ...(name === undefined ? {} : { name }),
      ...(email === undefined ? {} : { email }),
    };
  } catch {
    return null;
  }
}
