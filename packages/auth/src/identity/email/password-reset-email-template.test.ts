import { describe, expect, it } from 'vitest';

import { renderPasswordResetEmail } from './password-reset-email-template.js';
import type { EmailTemplate } from './sender.js';

/**
 * `044` task 3.2 (design D8): the fixed password reset email. Scenario "The template
 * carries no free text" of `specs/password-reset-and-account-recovery/spec.md` and the
 * case "the body holds exactly one link".
 */

type ResetTemplate = Extract<EmailTemplate, { kind: 'PasswordResetEmail' }>;

const LINK = 'https://app.example.test/reset-password#reset=rst_123&token=tok_456';
const EXPIRY = '30 minutes';

const MARKUP_ORG = '<b>Pay now</b>';
const MARKUP_ADMIN = '<img src="https://evil.example/x.png"><script>alert(1)</script>Mallory';

function template(overrides: Partial<ResetTemplate> = {}): ResetTemplate {
  return { kind: 'PasswordResetEmail', link: LINK, expiryText: EXPIRY, ...overrides };
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');
}

/** Every opening tag of the document with its decoded attributes. */
function parseTags(html: string): { name: string; attributes: Record<string, string> }[] {
  const tags: { name: string; attributes: Record<string, string> }[] = [];
  for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\s*\/?>/g)) {
    const attributes: Record<string, string> = {};
    for (const attr of (match[2] ?? '').matchAll(
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    )) {
      attributes[(attr[1] ?? '').toLowerCase()] = decodeEntities(
        attr[2] ?? attr[3] ?? attr[4] ?? '',
      );
    }
    tags.push({ name: (match[1] ?? '').toLowerCase(), attributes });
  }
  return tags;
}

function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '));
}

function urlsIn(value: string): string[] {
  return value.match(/(?:https?|ftp|mailto|javascript|data):[^\s"'<>]*/gi) ?? [];
}

describe('renderPasswordResetEmail: the body holds exactly one link', () => {
  it('renders a subject, an HTML body and a text body', () => {
    const rendered = renderPasswordResetEmail(template());
    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.html.length).toBeGreaterThan(0);
    expect(rendered.text.length).toBeGreaterThan(0);
  });

  it('contains exactly one anchor in the HTML and it points at the link', () => {
    const { html } = renderPasswordResetEmail(template());
    const anchors = parseTags(html).filter((tag) => tag.name === 'a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.attributes['href']).toBe(LINK);
  });

  it('has no other clickable or loading element in the HTML', () => {
    const { html } = renderPasswordResetEmail(template());
    const tags = parseTags(html);
    const withUrls = tags.filter(
      (tag) =>
        tag.name !== 'a' &&
        ['href', 'src', 'action', 'formaction', 'srcset', 'background', 'data', 'poster'].some(
          (name) => name in tag.attributes,
        ),
    );
    expect(withUrls).toEqual([]);
    expect(
      tags.filter((tag) => ['form', 'img', 'script', 'iframe', 'link', 'area'].includes(tag.name)),
    ).toEqual([]);
  });

  it('shows no URL in the HTML other than the one href', () => {
    const { html } = renderPasswordResetEmail(template());
    const anchorHref = parseTags(html).find((tag) => tag.name === 'a')?.attributes['href'];
    const urls = [...urlsIn(visibleText(html)), ...(anchorHref === undefined ? [] : [anchorHref])];
    expect(new Set(urls)).toEqual(new Set([LINK]));
  });

  it('contains the link exactly once in the text body and no other URL', () => {
    const { text } = renderPasswordResetEmail(template());
    expect(text.split(LINK)).toHaveLength(2);
    expect(urlsIn(text)).toEqual([LINK]);
  });

  it('states the expiry text in the HTML and the text body', () => {
    const { html, text } = renderPasswordResetEmail(template());
    expect(visibleText(html)).toContain(EXPIRY);
    expect(text).toContain(EXPIRY);
  });

  it('keeps the link intact through HTML escaping of its ampersand', () => {
    const { html } = renderPasswordResetEmail(template());
    expect(html).not.toContain('reset=rst_123&token=');
    expect(parseTags(html).find((tag) => tag.name === 'a')?.attributes['href']).toBe(LINK);
  });
});

describe('renderPasswordResetEmail: The template carries no free text', () => {
  // The port gives the template nothing but a link and an expiry text. These tests also
  // smuggle organization and admin free text onto the template object, as a caller that
  // mistakenly forwarded it would, and require that it never shows.
  const smuggled = {
    ...template(),
    organizationName: MARKUP_ORG,
    organization: { name: MARKUP_ORG },
    adminName: MARKUP_ADMIN,
    admin: { name: MARKUP_ADMIN },
    name: MARKUP_ORG,
  } as ResetTemplate;

  it('never shows the organization name or the admin name in subject, HTML or text', () => {
    const { subject, html, text } = renderPasswordResetEmail(smuggled);
    for (const part of [subject, html, text]) {
      expect(part).not.toContain(MARKUP_ORG);
      expect(part).not.toContain('Pay now');
      expect(part).not.toContain('Mallory');
      expect(part).not.toContain('evil.example');
      expect(part).not.toContain('alert(1)');
    }
  });

  it('renders the same output with or without the smuggled free text', () => {
    expect(renderPasswordResetEmail(smuggled)).toEqual(renderPasswordResetEmail(template()));
  });

  it('uses a fixed subject that does not depend on the link or the expiry text', () => {
    const first = renderPasswordResetEmail(template());
    const second = renderPasswordResetEmail(
      template({
        link: 'https://other.example.test/reset-password#reset=x&token=y',
        expiryText: '1 hour',
      }),
    );
    expect(second.subject).toBe(first.subject);
    expect(first.subject.length).toBeGreaterThan(0);
    expect(first.subject).not.toMatch(/[\r\n]/);
    expect(first.subject).not.toContain(LINK);
    expect(first.subject).not.toContain(EXPIRY);
  });

  it('interpolates only the link and the expiry text into the body', () => {
    const linkA = 'https://a.example.test/reset-password#reset=AAA&token=AAA';
    const linkB = 'https://b.example.test/reset-password#reset=BBB&token=BBB';
    const a = renderPasswordResetEmail(template({ link: linkA, expiryText: 'EXPIRY-A' }));
    const b = renderPasswordResetEmail(template({ link: linkB, expiryText: 'EXPIRY-B' }));

    const normalize = (value: string, link: string, expiry: string): string =>
      value
        .replaceAll(link.replaceAll('&', '&amp;'), '{LINK}')
        .replaceAll(link, '{LINK}')
        .replaceAll(expiry, '{EXPIRY}');

    expect(normalize(a.html, linkA, 'EXPIRY-A')).toBe(normalize(b.html, linkB, 'EXPIRY-B'));
    expect(normalize(a.text, linkA, 'EXPIRY-A')).toBe(normalize(b.text, linkB, 'EXPIRY-B'));
    expect(a.html).toContain('EXPIRY-A');
    expect(a.html).not.toContain('EXPIRY-B');
  });

  it('escapes markup in the expiry text so it cannot add elements to the HTML', () => {
    const { html } = renderPasswordResetEmail(template({ expiryText: MARKUP_ORG }));
    expect(html).not.toContain(MARKUP_ORG);
    expect(parseTags(html).filter((tag) => tag.name === 'b')).toEqual([]);
  });

  it('is deterministic: the same input renders the same output', () => {
    expect(renderPasswordResetEmail(template())).toEqual(renderPasswordResetEmail(template()));
  });
});
