import { describe, expect, it } from 'vitest';

import { renderInvitationEmail } from './invitation-email-template.js';
import type { EmailTemplate } from './sender.js';

/**
 * `043` task 6.2 (design D5): the fixed invitation email template. Scenarios:
 * "The template carries no free text" and "Invite sends exactly one email with
 * exactly one link".
 */

type InvitationTemplate = Extract<EmailTemplate, { kind: 'InvitationEmail' }>;

const LINK = 'https://app.example.test/accept-invitation#invitation=inv_123&token=tok_456';
const EXPIRY = '48 hours';

const MARKUP_ORG = '<b>Pay now</b>';
const MARKUP_INVITER = '<img src="https://evil.example/x.png"><script>alert(1)</script>Mallory';

function template(overrides: Partial<InvitationTemplate> = {}): InvitationTemplate {
  return { kind: 'InvitationEmail', link: LINK, expiryText: EXPIRY, ...overrides };
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

/** The text content of the HTML: tags removed, entities decoded. */
function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '));
}

function urlsIn(value: string): string[] {
  return value.match(/(?:https?|ftp|mailto|javascript|data):[^\s"'<>]*/gi) ?? [];
}

describe('renderInvitationEmail: Invite sends exactly one email with exactly one link', () => {
  it('renders a subject, an HTML body and a text body', () => {
    const rendered = renderInvitationEmail(template());
    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.html.length).toBeGreaterThan(0);
    expect(rendered.text.length).toBeGreaterThan(0);
  });

  it('contains exactly one anchor in the HTML and it points at the link', () => {
    const { html } = renderInvitationEmail(template());
    const anchors = parseTags(html).filter((tag) => tag.name === 'a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.attributes['href']).toBe(LINK);
  });

  it('has no other clickable or loading element in the HTML', () => {
    const { html } = renderInvitationEmail(template());
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
    const { html } = renderInvitationEmail(template());
    const anchorHref = parseTags(html).find((tag) => tag.name === 'a')?.attributes['href'];
    const urls = [...urlsIn(visibleText(html)), ...(anchorHref === undefined ? [] : [anchorHref])];
    expect(new Set(urls)).toEqual(new Set([LINK]));
  });

  it('contains the link exactly once in the text body and no other URL', () => {
    const { text } = renderInvitationEmail(template());
    expect(text.split(LINK)).toHaveLength(2);
    expect(urlsIn(text)).toEqual([LINK]);
  });

  it('states the expiry text in the HTML and the text body', () => {
    const { html, text } = renderInvitationEmail(template());
    expect(visibleText(html)).toContain(EXPIRY);
    expect(text).toContain(EXPIRY);
  });

  it('keeps the link intact through HTML escaping of its ampersand', () => {
    const { html } = renderInvitationEmail(template());
    expect(html).not.toContain('invitation=inv_123&token=');
    expect(parseTags(html).find((tag) => tag.name === 'a')?.attributes['href']).toBe(LINK);
  });
});

describe('renderInvitationEmail: The template carries no free text', () => {
  // The port gives the template nothing but a link and an expiry text. These tests
  // also smuggle tenant and inviter free text onto the template object, as a caller
  // that mistakenly forwarded it would, and require that it never shows.
  const smuggled = {
    ...template(),
    organizationName: MARKUP_ORG,
    organization: { name: MARKUP_ORG },
    inviterName: MARKUP_INVITER,
    inviter: { name: MARKUP_INVITER },
    name: MARKUP_ORG,
  } as InvitationTemplate;

  it('never shows the organization name or the inviter name in subject, HTML or text', () => {
    const { subject, html, text } = renderInvitationEmail(smuggled);
    for (const part of [subject, html, text]) {
      expect(part).not.toContain(MARKUP_ORG);
      expect(part).not.toContain('Pay now');
      expect(part).not.toContain('Mallory');
      expect(part).not.toContain('evil.example');
      expect(part).not.toContain('alert(1)');
    }
  });

  it('renders the same output with or without the smuggled free text', () => {
    expect(renderInvitationEmail(smuggled)).toEqual(renderInvitationEmail(template()));
  });

  it('uses a fixed subject that does not depend on the link or the expiry text', () => {
    const first = renderInvitationEmail(template());
    const second = renderInvitationEmail(
      template({
        link: 'https://other.example.test/accept-invitation#invitation=x&token=y',
        expiryText: '1 hour',
      }),
    );
    expect(second.subject).toBe(first.subject);
    expect(first.subject).not.toMatch(/[\r\n]/);
    expect(first.subject).not.toContain(LINK);
    expect(first.subject).not.toContain(EXPIRY);
  });

  it('interpolates only the link and the expiry text into the body', () => {
    const linkA = 'https://a.example.test/accept-invitation#invitation=AAA&token=AAA';
    const linkB = 'https://b.example.test/accept-invitation#invitation=BBB&token=BBB';
    const a = renderInvitationEmail(template({ link: linkA, expiryText: 'EXPIRY-A' }));
    const b = renderInvitationEmail(template({ link: linkB, expiryText: 'EXPIRY-B' }));

    const htmlLinkA = linkA.replaceAll('&', '&amp;');
    const htmlLinkB = linkB.replaceAll('&', '&amp;');
    const normalize = (value: string, link: string, htmlLink: string, expiry: string): string =>
      value
        .replaceAll(htmlLink, '{LINK}')
        .replaceAll(link, '{LINK}')
        .replaceAll(expiry, '{EXPIRY}');

    expect(normalize(a.html, linkA, htmlLinkA, 'EXPIRY-A')).toBe(
      normalize(b.html, linkB, htmlLinkB, 'EXPIRY-B'),
    );
    expect(normalize(a.text, linkA, htmlLinkA, 'EXPIRY-A')).toBe(
      normalize(b.text, linkB, htmlLinkB, 'EXPIRY-B'),
    );
    expect(a.html).toContain('EXPIRY-A');
    expect(a.html).not.toContain('EXPIRY-B');
  });

  it('escapes markup in the expiry text so it cannot add elements to the HTML', () => {
    const { html } = renderInvitationEmail(template({ expiryText: MARKUP_ORG }));
    expect(html).not.toContain(MARKUP_ORG);
    expect(parseTags(html).filter((tag) => tag.name === 'b')).toEqual([]);
  });

  it('is deterministic: the same input renders the same output', () => {
    expect(renderInvitationEmail(template())).toEqual(renderInvitationEmail(template()));
  });
});
