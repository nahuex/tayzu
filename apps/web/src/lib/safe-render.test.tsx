/**
 * Safe rendering of server strings (task 5.10, design D13 and Q16, `001` threat T4;
 * spec "A dangerous URL value stays text").
 *
 * D13 (Safe rendering): "A URL value becomes a link only if it parses as an absolute
 * `http:` or `https:` URL (a `mailto:` link only for the `email` format), with
 * `rel="noopener noreferrer nofollow"` and `target="_blank"`; anything else is text.
 * Markdown goes through `react-markdown` with raw HTML skipped, images disallowed (no
 * tracking pixels, and `img-src 'self'` would block them anyway), and a URL transform
 * that keeps only `http:`, `https:` and `mailto:`. No server string is ever passed to
 * `dangerouslySetInnerHTML`."
 *
 * Spec, scenario "A dangerous URL value stays text": GIVEN an entity whose `url`
 * property holds `javascript:alert(1)`, WHEN the table and the entity page show it,
 * THEN it is shown as text and is not a link. (The table and the entity page are
 * covered by tasks 7.2 and 8.2; this file covers the renderers they use.)
 *
 * Assumed API:
 *
 * ```ts
 * // src/lib/safe-link.tsx
 * // A `url` property value. An `<a>` only when `href` parses (WHATWG URL, no base) as
 * // an absolute `http:` or `https:` URL; its text is `href`, and it carries
 * // `rel="noopener noreferrer nofollow"` and `target="_blank"`. Any other value
 * // (another scheme, `mailto:` included, a relative or protocol-relative value, text
 * // that does not parse) renders as plain text equal to `href`, with no element
 * // carrying an `href`.
 * export function SafeLink(props: { readonly href: string }): React.JSX.Element;
 *
 * // An `email` property value: an `<a href="mailto:<address>">` (the address
 * // appended as is) whose text is `address`, with the same `rel` and `target`. It
 * // never produces an `href` with a scheme other than `mailto:`.
 * export function SafeEmailLink(props: { readonly address: string }): React.JSX.Element;
 *
 * // src/lib/markdown.tsx
 * // A `markdown` property value through `react-markdown`: raw HTML skipped, images
 * // disallowed, and only absolute `http:`, `https:` and `mailto:` link targets kept
 * // (a link with any other target renders no `href`). Every rendered `<a>` carries
 * // `rel="noopener noreferrer nofollow"` and `target="_blank"`.
 * export function Markdown(props: { readonly source: string }): React.JSX.Element;
 * ```
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from './markdown.js';
import { SafeEmailLink, SafeLink } from './safe-link.js';

const SAFE_REL = 'noopener noreferrer nofollow';
const SAFE_TARGET = '_blank';

/** The only schemes a rendered `href` may carry (D13, Q16). */
const ALLOWED_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:'];

/** Elements that run code, load a resource, navigate or submit. */
const FORBIDDEN_ELEMENTS = [
  'script',
  'img',
  'iframe',
  'frame',
  'frameset',
  'style',
  'link',
  'meta',
  'base',
  'object',
  'embed',
  'svg',
  'video',
  'audio',
  'source',
  'picture',
  'track',
  'form',
] as const;

/** Attributes that load a resource or carry styles that can (`url(...)`). */
const FORBIDDEN_ATTRIBUTES = [
  'src',
  'srcset',
  'srcdoc',
  'action',
  'formaction',
  'data',
  'poster',
  'background',
  'ping',
  'style',
  'xlink:href',
] as const;

/** True when `href` parses as an absolute URL with an allowed scheme. */
function hasAllowedScheme(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return ALLOWED_SCHEMES.includes(url.protocol);
}

/**
 * Asserts that nothing under `container` runs code or loads a resource: no forbidden
 * element, no `on*` attribute, no resource attribute, and every `href` on an `<a>`
 * with an absolute `http:`, `https:` or `mailto:` URL.
 */
function expectInert(container: HTMLElement): void {
  for (const tag of FORBIDDEN_ELEMENTS) {
    expect(container.querySelectorAll(tag), `<${tag}> element`).toHaveLength(0);
  }
  for (const element of container.querySelectorAll('*')) {
    for (const attribute of element.getAttributeNames()) {
      const name = attribute.toLowerCase();
      expect(name.startsWith('on'), `${name} attribute on <${element.localName}>`).toBe(false);
      expect(FORBIDDEN_ATTRIBUTES, `${name} attribute on <${element.localName}>`).not.toContain(
        name,
      );
    }
    const href = element.getAttribute('href');
    if (href !== null) {
      expect(element.localName, `href on <${element.localName}>`).toBe('a');
      expect(hasAllowedScheme(href), `href ${JSON.stringify(href)}`).toBe(true);
    }
  }
}

/** Asserts the safe link attributes on one `<a>`. */
function expectSafeAttributes(link: HTMLElement): void {
  expect(link).toHaveAttribute('rel', SAFE_REL);
  expect(link).toHaveAttribute('target', SAFE_TARGET);
}

describe('SafeLink', () => {
  describe('A dangerous URL value stays text', () => {
    const DANGEROUS_VALUES: readonly (readonly [label: string, value: string])[] = [
      ['javascript:', 'javascript:alert(1)'],
      ['javascript: in mixed case', 'JaVaScRiPt:alert(1)'],
      ['javascript: with a leading space', ' javascript:alert(1)'],
      ['javascript: with leading control characters', '\u0001javascript:alert(1)'],
      ['javascript: with a tab inside', 'java\tscript:alert(1)'],
      ['javascript: with a newline inside', 'java\nscript:alert(1)'],
      ['javascript: with a carriage return inside', 'java\rscript:alert(1)'],
      ['javascript: entity-encoded colon', 'javascript&colon;alert(1)'],
      ['javascript: numeric-entity colon', 'javascript&#58;alert(1)'],
      ['javascript: with an authority', 'javascript://example.com/%0Aalert(1)'],
      ['data: HTML', 'data:text/html,<script>alert(1)</script>'],
      ['data: base64 HTML', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
      ['data: in upper case', 'DATA:text/html,x'],
      ['vbscript:', 'vbscript:msgbox(1)'],
      ['vbscript: in upper case', 'VBSCRIPT:msgbox(1)'],
      ['file:', 'file:///etc/passwd'],
      ['blob:', 'blob:https://example.com/0b6f4c6e-9a8e-4c55-8f0e-1f1b8b0c2d3e'],
      ['ftp:', 'ftp://example.com/file'],
      ['about:', 'about:blank'],
      ['mailto: in a url value (mailto is for the email format only)', 'mailto:a@example.com'],
      ['a root-relative path', '/catalog/service'],
      ['a relative path', 'catalog/service'],
      ['a parent-relative path', '../admin'],
      ['a protocol-relative value', '//evil.example/x'],
      ['a backslash protocol-relative value', '\\\\evil.example\\x'],
      ['a query only', '?returnTo=/admin'],
      ['a fragment only', '#top'],
      ['a host without a scheme', 'example.com'],
      ['the empty string', ''],
    ];

    it.each(DANGEROUS_VALUES)('%s is shown as text and is not a link', (_label, value) => {
      const { container } = render(<SafeLink href={value} />);

      expect(screen.queryByRole('link')).toBeNull();
      expect(container.querySelector('a')).toBeNull();
      expect(container.querySelector('[href]')).toBeNull();
      expect(container.textContent).toBe(value);
      expectInert(container);
    });
  });

  describe('an absolute http: or https: URL becomes a safe link', () => {
    const SAFE_VALUES: readonly string[] = [
      'https://example.com/docs?page=2#install',
      'http://example.com/',
      'https://docs.example.com/a/b',
    ];

    it.each(SAFE_VALUES)('%s is a link with its value as text and href', (value) => {
      const { container } = render(<SafeLink href={value} />);

      const link = screen.getByRole('link', { name: value });
      expect(link).toHaveAttribute('href', value);
      expect(container.querySelectorAll('a')).toHaveLength(1);
      expectInert(container);
    });

    it.each(SAFE_VALUES)(
      '%s has rel="noopener noreferrer nofollow" and target="_blank"',
      (value) => {
        render(<SafeLink href={value} />);

        expectSafeAttributes(screen.getByRole('link', { name: value }));
      },
    );
  });
});

describe('SafeEmailLink', () => {
  it('renders an email value as a mailto: link with the safe attributes', () => {
    const { container } = render(<SafeEmailLink address="ada@example.com" />);

    const link = screen.getByRole('link', { name: 'ada@example.com' });
    expect(link).toHaveAttribute('href', 'mailto:ada@example.com');
    expectSafeAttributes(link);
    expectInert(container);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/x',
  ])('never produces an href with a scheme other than mailto: for %s', (address) => {
    const { container } = render(<SafeEmailLink address={address} />);

    for (const element of container.querySelectorAll('[href]')) {
      const href = element.getAttribute('href') ?? '';
      expect(new URL(href).protocol, `href ${JSON.stringify(href)}`).toBe('mailto:');
    }
    expect(container.textContent).toBe(address);
    expectInert(container);
  });
});

describe('Markdown', () => {
  it('renders markdown formatting', () => {
    const { container } = render(<Markdown source={'Some **bold** and _emphasized_ text.'} />);

    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('emphasized');
    expectInert(container);
  });

  describe('renders no element that runs code or loads a resource', () => {
    const DANGEROUS_SOURCES: readonly (readonly [label: string, source: string])[] = [
      ['a block <script>', '<script>\nalert(1)\n</script>'],
      ['an inline <script>', 'Hello <script>alert(1)</script> world'],
      ['a <script src>', '<script src="https://evil.example/x.js"></script>'],
      ['an <img onerror>', '<img src="x" onerror="alert(1)">'],
      ['an inline <img onerror>', 'Look <img src=x onerror=alert(1)> here'],
      ['a markdown image', '![pixel](https://tracker.example/p.png)'],
      ['a reference-style image', '![pixel][p]\n\n[p]: https://tracker.example/p.png'],
      ['an image inside a link', '[![pixel](https://tracker.example/p.png)](https://example.com/)'],
      ['a javascript: link', '[click](javascript:alert(1))'],
      ['a javascript: link in mixed case', '[click](JaVaScRiPt:alert(1))'],
      ['a javascript: link with an entity-encoded colon', '[click](javascript&#58;alert(1))'],
      ['a javascript: link with a named-entity colon', '[click](javascript&colon;alert(1))'],
      ['a javascript: autolink', '<javascript:alert(1)>'],
      ['a javascript: reference link', '[click][x]\n\n[x]: javascript:alert(1)'],
      ['a data: link', '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
      ['a vbscript: link', '[click](vbscript:msgbox(1))'],
      ['a relative link', '[click](/catalog/service)'],
      ['a protocol-relative link', '[click](//evil.example/x)'],
      ['a raw HTML <a href> with javascript:', '<a href="javascript:alert(1)">click</a>'],
      ['a raw HTML <a href> with https:', '<a href="https://example.com/">click</a>'],
      ['an <iframe>', '<iframe src="https://evil.example/"></iframe>'],
      ['an <iframe srcdoc>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
      ['a <style>', '<style>body { background: url(https://tracker.example/p) }</style>'],
      ['a style attribute', '<div style="background: url(https://tracker.example/p)">x</div>'],
      ['an <object>', '<object data="https://evil.example/x.swf"></object>'],
      ['an <embed>', '<embed src="https://evil.example/x.swf">'],
      ['an <svg onload>', '<svg onload="alert(1)"><circle r="1"/></svg>'],
      ['a <link>', '<link rel="stylesheet" href="https://evil.example/x.css">'],
      ['a <meta> refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
      ['a <base>', '<base href="https://evil.example/">'],
      ['a <form>', '<form action="https://evil.example/"><button>Go</button></form>'],
      ['a <video poster>', '<video poster="https://tracker.example/p.png"></video>'],
      ['an on* attribute on an allowed tag', '<p onclick="alert(1)">click</p>'],
    ];

    it.each(DANGEROUS_SOURCES)('for %s', (_label, source) => {
      const { container } = render(<Markdown source={source} />);

      expectInert(container);
    });

    it.each([
      ['a raw HTML <a href> with javascript:', '<a href="javascript:alert(1)">click</a>'],
      ['a raw HTML <a href> with https:', '<a href="https://example.com/">click</a>'],
    ])('skips raw HTML: %s renders no link', (_label, source) => {
      const { container } = render(<Markdown source={source} />);

      expect(screen.queryByRole('link')).toBeNull();
      expect(container.querySelector('a')).toBeNull();
    });

    it('keeps an allowed link next to a dangerous one and drops only the dangerous target', () => {
      const { container } = render(
        <Markdown source={'[safe](https://example.com/ok) and [bad](javascript:alert(1))'} />,
      );

      const safe = screen.getByRole('link', { name: 'safe' });
      expect(safe).toHaveAttribute('href', 'https://example.com/ok');
      expect(screen.getAllByRole('link')).toHaveLength(1);
      expectInert(container);
    });
  });

  describe('allowed links get the safe link attributes', () => {
    const ALLOWED_LINKS: readonly (readonly [
      label: string,
      source: string,
      name: string,
      href: string,
    ])[] = [
      ['an https: link', '[docs](https://example.com/docs)', 'docs', 'https://example.com/docs'],
      ['an http: link', '[site](http://example.com/)', 'site', 'http://example.com/'],
      ['a mailto: link', '[mail](mailto:ada@example.com)', 'mail', 'mailto:ada@example.com'],
      [
        'an https: autolink',
        '<https://example.com/a>',
        'https://example.com/a',
        'https://example.com/a',
      ],
      [
        'an https: reference link',
        '[ref][r]\n\n[r]: https://example.com/ref',
        'ref',
        'https://example.com/ref',
      ],
    ];

    it.each(ALLOWED_LINKS)(
      '%s is a link with rel="noopener noreferrer nofollow" and target="_blank"',
      (_label, source, name, href) => {
        const { container } = render(<Markdown source={source} />);

        const link = screen.getByRole('link', { name });
        expect(link).toHaveAttribute('href', href);
        expectSafeAttributes(link);
        expectInert(container);
      },
    );

    it('puts the safe attributes on every link of a document', () => {
      render(
        <Markdown
          source={
            'See [one](https://example.com/1), [two](http://example.com/2) and ' +
            '[three](mailto:ops@example.com).'
          }
        />,
      );

      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(3);
      for (const link of links) {
        expectSafeAttributes(link);
      }
    });
  });
});
