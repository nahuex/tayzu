/**
 * Return paths (task 5.4, design D15 and D12; scenario "An external return path is
 * ignored").
 *
 * D15: "A `returnTo` value or the stored step-up path is accepted only if it starts
 * with a single `/`, contains no `//`, `\` or control character, has no scheme or host
 * when resolved against the current origin, and matches a route of the route tree;
 * anything else becomes `/`." The route tree is D12's: `/`, `/catalog/$blueprint`,
 * `/catalog/$blueprint/$entity`, `/search` and the public and gate pages.
 *
 * Assumed API of `./return-path.js`:
 *
 * ```ts
 * // Returns `value` unchanged when it is an in-app path of the route tree (an
 * // optional query string after the path is allowed), and `/` for anything else,
 * // including a value that is not a string. Never throws.
 * export function safeReturnPath(value: unknown): string;
 * ```
 */
import { describe, expect, it } from 'vitest';

import { safeReturnPath } from './return-path.js';

describe('An external return path is ignored', () => {
  it('replaces the scenario value //evil.example/x by /', () => {
    expect(safeReturnPath('//evil.example/x')).toBe('/');
  });

  it.each([
    '//host',
    '//host/catalog/service',
    '///host',
    '//user@host/',
    '/catalog//host',
    '/search?q=a//b',
  ])('replaces the protocol-relative or doubled-slash form %j by /', (value) => {
    expect(safeReturnPath(value)).toBe('/');
  });

  it.each([
    '/\\host',
    '/\\\\host',
    '\\\\host',
    '\\/host',
    '/\\/host',
    '/catalog\\service',
    '/catalog/service\\..\\..\\host',
    '/search?q=a\\b',
  ])('replaces the backslash form %j by /', (value) => {
    expect(safeReturnPath(value)).toBe('/');
  });

  it.each([
    'https://host',
    'https://evil.example/x',
    'HTTPS://host/',
    'http://host',
    'https:/host',
    'https:host',
    'ftp://host/',
    `${window.location.origin}/catalog/service`,
  ])('replaces the absolute URL %j by /', (value) => {
    expect(safeReturnPath(value)).toBe('/');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'javascript://%0aalert(1)',
    'data:text/html,x',
    'vbscript:x',
    '/javascript:alert(1)',
  ])('replaces the script or data URL %j by /', (value) => {
    expect(safeReturnPath(value)).toBe('/');
  });

  it.each([
    ['a tab between the slashes', '/\t/host'],
    ['a newline between the slashes', '/\n/host'],
    ['a carriage return and newline', '/\r\n/host'],
    ['a leading tab', '\t//host'],
    ['a tab inside the scheme', 'java\tscript:alert(1)'],
    ['a newline inside the scheme', 'java\nscript:alert(1)'],
    ['a NUL in a path', '/catalog/service\u0000'],
    ['a unit separator in a path', '/catalog/ser\u001fvice'],
    ['a DEL in a path', '/catalog/service\u007f'],
    ['a C1 control in a path', '/catalog/service\u0085'],
    ['a newline in the query', '/search?q=a\nb'],
    ['a tab in a valid path', '/catalog/\tservice'],
  ])('replaces a value with %s by /', (_label, value) => {
    expect(safeReturnPath(value)).toBe('/');
  });

  it.each([
    ['a leading space', ' //host'],
    ['a leading space before a valid path', ' /catalog/service'],
    ['an encoded double slash', '%2F%2Fhost'],
    ['an encoded double slash after a slash', '/%2F%2Fhost'],
    ['an encoded backslash', '/%5Chost'],
    ['an encoded double backslash', '%5C%5Chost'],
    ['an encoded tab', '/%09/host'],
    ['fullwidth solidi', '／／host'],
    ['a relative path', 'catalog/service'],
    ['a dot path', './catalog/service'],
    ['a query only', '?q=x'],
    ['a fragment only', '#x'],
    ['an empty string', ''],
  ])('replaces a value with %s by /', (_label, value) => {
    expect(safeReturnPath(value)).toBe('/');
  });

  it.each([
    '/nope',
    '/catalog',
    '/catalog/service/entity/extra',
    '/search/x',
    '/v1/me',
    '/api/auth/sign-out',
    '/assets/index.js',
    '/healthz',
    '/theme-init.js',
    '/@evil.example',
    '/catalog/../../evil',
    '/nope?q=x',
  ])('replaces the unknown route %j by /', (value) => {
    expect(safeReturnPath(value)).toBe('/');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { pathname: '/catalog/service' }],
    ['an array', ['/catalog/service']],
    ['a URL', new URL('/catalog/service', window.location.origin)],
  ])('replaces %s by /', (_label, value) => {
    expect(safeReturnPath(value)).toBe('/');
  });
});

describe('safeReturnPath: in-app paths are kept', () => {
  it.each([
    ['the home', '/'],
    ['a blueprint list', '/catalog/service'],
    ['a system blueprint list', '/catalog/_user'],
    ['an entity', '/catalog/service/payments-api'],
    ['an entity with @, : and =', '/catalog/service/team@example.com:prod=1'],
    ['a user entity', '/catalog/_user/alice@example.com'],
    ['an entity with a dot', '/catalog/service/v1.2'],
    ['an entity tab', '/catalog/service/payments-api?tab=related'],
    ['a sorted table', '/catalog/service?sort=title&order=asc&pageSize=50'],
    ['the search page', '/search'],
    ['a search with a query string', '/search?q=payments'],
  ])('keeps %s', (_label, value) => {
    expect(safeReturnPath(value)).toBe(value);
  });
});
