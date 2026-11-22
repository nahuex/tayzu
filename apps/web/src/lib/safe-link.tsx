/**
 * Safe links for `url` and `email` property values (design D13, Q16, `001`
 * threat T4; scenario "A dangerous URL value stays text").
 *
 * A value becomes a link only when it parses, with no base, as an absolute URL
 * of an allowed scheme; anything else is rendered as plain text. Every link
 * opens in a new browsing context with no opener, no referrer and no follow.
 */
import type { JSX } from 'react';

/** The `rel` of every link built from a server string. */
export const SAFE_LINK_REL = 'noopener noreferrer nofollow';

/** The `target` of every link built from a server string. */
export const SAFE_LINK_TARGET = '_blank';

/**
 * True when `value` parses (WHATWG URL, no base) as an absolute URL whose
 * scheme is one of `protocols` (each with its trailing `:`). Never throws.
 */
export function hasAllowedProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const URL_PROTOCOLS: readonly string[] = ['http:', 'https:'];

const EMAIL_PROTOCOLS: readonly string[] = ['mailto:'];

/** A `url` property value: a link for an absolute `http:` or `https:` URL, text otherwise. */
export function SafeLink({ href }: { readonly href: string }): JSX.Element {
  if (!hasAllowedProtocol(href, URL_PROTOCOLS)) return <>{href}</>;
  return (
    <a href={href} rel={SAFE_LINK_REL} target={SAFE_LINK_TARGET}>
      {href}
    </a>
  );
}

/**
 * An `email` property value as a `mailto:` link. The fixed prefix makes the
 * scheme `mailto:`; the parse check fails closed to text if it ever is not.
 */
export function SafeEmailLink({ address }: { readonly address: string }): JSX.Element {
  const href = `mailto:${address}`;
  if (!hasAllowedProtocol(href, EMAIL_PROTOCOLS)) return <>{address}</>;
  return (
    <a href={href} rel={SAFE_LINK_REL} target={SAFE_LINK_TARGET}>
      {address}
    </a>
  );
}
