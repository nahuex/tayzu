import { describe, expect, it } from 'vitest';

import { renderAdminAcceptedNotice } from './admin-accepted-notice-template.js';
import type { EmailTemplate } from './sender.js';

/**
 * `043` task 6.11 (design D5, Resolved decision Q39): the fixed admin-accepted
 * notice. Scenario: "The admin notice carries no free text".
 */

type NoticeTemplate = Extract<EmailTemplate, { kind: 'AdminAcceptedNotice' }>;

const MARKUP_ORG = '<b>Pay now</b>';
const MARKUP_INVITEE = '<img src="https://evil.example/x.png"><script>alert(1)</script>Mallory';

function template(): NoticeTemplate {
  return { kind: 'AdminAcceptedNotice' };
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

describe('renderAdminAcceptedNotice: The admin notice carries no free text', () => {
  // The notice template takes no value at all. These tests also smuggle tenant and
  // invitee free text onto the template object, as a caller that mistakenly
  // forwarded it would, and require that it never shows.
  const smuggled = {
    ...template(),
    organizationName: MARKUP_ORG,
    organization: { name: MARKUP_ORG },
    inviteeName: MARKUP_INVITEE,
    invitee: { name: MARKUP_INVITEE, email: 'mallory@evil.example' },
    name: MARKUP_ORG,
    link: 'https://evil.example/phish',
  } as NoticeTemplate;

  it('renders a non-empty subject, HTML body and text body', () => {
    const rendered = renderAdminAcceptedNotice(template());
    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.html.length).toBeGreaterThan(0);
    expect(rendered.text.length).toBeGreaterThan(0);
  });

  it('never shows the organization name or the invitee name in subject, HTML or text', () => {
    const { subject, html, text } = renderAdminAcceptedNotice(smuggled);
    for (const part of [subject, html, text]) {
      expect(part).not.toContain(MARKUP_ORG);
      expect(part).not.toContain('Pay now');
      expect(part).not.toContain('Mallory');
      expect(part).not.toContain('evil.example');
      expect(part).not.toContain('alert(1)');
    }
  });

  it('has no interpolated value: smuggled input renders the same output as none', () => {
    expect(renderAdminAcceptedNotice(smuggled)).toEqual(renderAdminAcceptedNotice(template()));
  });

  it('is deterministic and has a fixed single-line subject', () => {
    const first = renderAdminAcceptedNotice(template());
    expect(renderAdminAcceptedNotice(template())).toEqual(first);
    expect(first.subject).not.toMatch(/[\r\n]/);
  });

  it('contains no link in the parsed HTML: no anchor and no URL-bearing element', () => {
    const { html } = renderAdminAcceptedNotice(smuggled);
    const tags = parseTags(html);
    expect(tags.filter((tag) => tag.name === 'a')).toEqual([]);
    expect(
      tags.filter((tag) =>
        ['href', 'src', 'action', 'formaction', 'srcset', 'background', 'data', 'poster'].some(
          (name) => name in tag.attributes,
        ),
      ),
    ).toEqual([]);
    expect(
      tags.filter((tag) =>
        ['a', 'form', 'img', 'script', 'iframe', 'link', 'area', 'b'].includes(tag.name),
      ),
    ).toEqual([]);
  });

  it('shows no URL in the visible HTML text, the text body or the subject', () => {
    const { subject, html, text } = renderAdminAcceptedNotice(smuggled);
    expect(urlsIn(visibleText(html))).toEqual([]);
    expect(urlsIn(text)).toEqual([]);
    expect(urlsIn(subject)).toEqual([]);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/https?:\/\//i);
  });
});
