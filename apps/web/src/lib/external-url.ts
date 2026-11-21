/**
 * External navigation targets (design D11 and Q72).
 *
 * A URL returned by the server is followed only when it parses, with no base, as an
 * absolute `https:` URL. Parsing with no base refuses relative and protocol-relative
 * values, which a base would resolve against the page's own origin. No host is pinned:
 * the check against the discovered issuer's origin is a ticket.
 */
export function isAbsoluteHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}
