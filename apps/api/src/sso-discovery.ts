/**
 * Startup check for the Visma Connect discovery document (task 23.21, design
 * Q48 and D23). SSO is configured, so a provider that cannot be discovered
 * stops startup instead of being skipped silently. Errors are fixed strings:
 * never the URL, the client credentials or any part of the response.
 */
const DISCOVERY_TIMEOUT_MS = 10_000;

/** Resolves the discovery document once and checks the fields the flow needs. */
export async function assertDiscoverable(discoveryUrl: string): Promise<void> {
  let document: unknown;
  try {
    const response = await fetch(discoveryUrl, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error('discovery failed');
    }
    document = await response.json();
  } catch {
    throw new Error('Visma Connect discovery failed at startup');
  }
  const fields = document as Record<string, unknown> | null;
  if (
    typeof fields !== 'object' ||
    fields === null ||
    typeof fields['issuer'] !== 'string' ||
    typeof fields['jwks_uri'] !== 'string'
  ) {
    throw new Error('Visma Connect discovery document is invalid');
  }
}
