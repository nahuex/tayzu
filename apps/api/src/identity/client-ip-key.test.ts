/**
 * `044` task 1.6 (design D16, Q28; spec "Reset traffic is limited before any lookup"): the
 * limiter key of a client address. An IPv4 address is its own key, an IPv4-mapped IPv6
 * address (dotted or hex form) is its IPv4 form, and any other IPv6 address is its first
 * 64 bits in expanded form with a zone id dropped.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/client-ip-key.ts (does not exist yet)
 * // Pure and total over the addresses Fastify's `request.ip` yields.
 * export function clientIpKey(address: string): string;
 * ```
 */
import { describe, expect, it } from 'vitest';

import { clientIpKey } from './client-ip-key.js';

describe('clientIpKey (task 1.6, design D16)', () => {
  it('an IPv4 address is its own key', () => {
    expect(clientIpKey('1.2.3.4')).toBe('1.2.3.4');
    expect(clientIpKey('203.0.113.77')).toBe('203.0.113.77');
  });

  it('a compressed and an expanded spelling of one IPv6 address give one key', () => {
    expect(clientIpKey('2001:db8::1')).toBe(clientIpKey('2001:0db8:0000:0000:0000:0000:0000:0001'));
    expect(clientIpKey('2001:db8:1:2::1')).toBe(clientIpKey('2001:0db8:0001:0002:0:0:0:1'));
  });

  it('a compression that spans the /64 boundary still keys on the first 64 bits', () => {
    expect(clientIpKey('2001:db8:1::5')).toBe(clientIpKey('2001:db8:1:0:9::1'));
    expect(clientIpKey('2001:db8:1::5')).not.toBe(clientIpKey('2001:db8:1:1::5'));
  });

  it('an IPv4-mapped IPv6 address equals its IPv4 form, in dotted and in hex form', () => {
    expect(clientIpKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientIpKey('::ffff:102:304')).toBe('1.2.3.4');
    expect(clientIpKey('::ffff:1.2.3.4')).toBe(clientIpKey('::ffff:102:304'));
  });

  it('an address with a zone id equals the same address without it', () => {
    expect(clientIpKey('fe80::1%eth0')).toBe(clientIpKey('fe80::1'));
  });

  it('two addresses in one /64 give one key', () => {
    expect(clientIpKey('2001:db8:1:2::1')).toBe(clientIpKey('2001:db8:1:2:ffff::9'));
  });

  it('two different /64s give different keys', () => {
    expect(clientIpKey('2001:db8:1:2::1')).not.toBe(clientIpKey('2001:db8:1:3::1'));
    expect(clientIpKey('2001:db8:1:2::1')).not.toBe(clientIpKey('2001:db8:2:2::1'));
  });

  it('an IPv4 key and an IPv6 key never collide for different clients', () => {
    expect(clientIpKey('1.2.3.4')).not.toBe(clientIpKey('2001:db8:1:2::1'));
  });

  it('the key never contains the address it was derived from', () => {
    for (const address of [
      '2001:db8:1:2:ffff::9',
      '2001:0db8:0001:0002:abcd:ef01:2345:6789',
      'fe80::1%eth0',
    ]) {
      expect(clientIpKey(address)).not.toContain(address);
    }
    expect(clientIpKey('2001:db8:1:2:abcd:ef01:2345:6789')).not.toContain('abcd:ef01');
    expect(clientIpKey('fe80::1%eth0')).not.toContain('eth0');
    expect(clientIpKey('fe80::1%eth0')).not.toContain('%');
  });
});
