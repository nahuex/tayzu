/**
 * The renderer for `markdown` property values (design D13, Q16, `001` threat
 * T4).
 *
 * `react-markdown` builds React elements, never an HTML string. Raw HTML is
 * skipped, images are dropped (no tracking pixels), and a link keeps its target
 * only when it is an absolute `http:`, `https:` or `mailto:` URL; any other link
 * renders as plain text with no `href`.
 */
import type { ComponentPropsWithoutRef, JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';

import { SAFE_LINK_REL, SAFE_LINK_TARGET, hasAllowedProtocol } from './safe-link.js';

const LINK_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:'];

const DISALLOWED_ELEMENTS: string[] = ['img'];

/** Keeps a URL only when it is absolute with an allowed scheme; drops it otherwise. */
function keepAllowedUrl(url: string): string | undefined {
  return hasAllowedProtocol(url, LINK_PROTOCOLS) ? url : undefined;
}

/**
 * A markdown link. Only `href`, `title` and the children are passed on, so no
 * other attribute reaches the DOM. A link whose URL was dropped is rendered as
 * plain inline text, so no element carries an `href`.
 */
function MarkdownLink({
  href,
  title,
  children,
}: ComponentPropsWithoutRef<'a'> & ExtraProps): JSX.Element {
  if (href === undefined || href === '') return <span title={title}>{children}</span>;
  return (
    <a href={href} title={title} rel={SAFE_LINK_REL} target={SAFE_LINK_TARGET}>
      {children}
    </a>
  );
}

const COMPONENTS: Components = { a: MarkdownLink };

/** A `markdown` property value, rendered without raw HTML, images or unsafe links. */
export function Markdown({ source }: { readonly source: string }): JSX.Element {
  return (
    <ReactMarkdown
      skipHtml
      disallowedElements={DISALLOWED_ELEMENTS}
      urlTransform={keepAllowedUrl}
      components={COMPONENTS}
    >
      {source}
    </ReactMarkdown>
  );
}
