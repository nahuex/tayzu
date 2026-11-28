/**
 * Unit test for task 3.2 of change `048-production-hardening` (design D2, Resolved decision
 * Q6): `createTrustProxy({ hops, cidrs })`.
 *
 * Task 3.2: "`createTrustProxy({ hops, cidrs })` trusts hop `i` only when `i < hops` and the
 * address is inside the CIDRs (design D2). Verify: `apps/api/src/trust-proxy.test.ts` covers
 * the spoofing matrix (a peer outside the range, a trusted peer, more forwarded values than
 * hops, an IPv4-mapped IPv6 peer, an IPv6 range) by calling the function the way
 * `proxy-addr` does."
 *
 * Design D2 (excerpt): "`createTrustProxy({ hops, cidrs })` (`apps/api/src/trust-proxy.ts`)
 * returns the `(address, hopIndex) => boolean` function Fastify accepts: `hopIndex < hops`
 * and the address (an IPv4-mapped IPv6 address reduced to its IPv4 form first) is inside the
 * `BlockList`. Fastify (through `proxy-addr`) evaluates hop 0 as the socket peer and walks
 * `X-Forwarded-For` from the right, stopping at the first untrusted address, so a peer
 * outside the CIDRs never has its header read, and at most `hops` entries are ever skipped."
 *
 * Spec `auth-and-rbac` "The client address comes only from trusted proxy hops" (excerpt):
 * "A forwarded address supplied by a peer outside those ranges, or beyond the configured hop
 * count, MUST be ignored, and the connection's own peer address MUST be used instead. [...]
 * IPv4-mapped IPv6 peer addresses MUST be compared as their IPv4 form."
 *
 * The test calls the function twice over:
 *
 * 1. Directly, as `proxy-addr` does: `trust(address, hopIndex)`, hop 0 being the socket peer.
 * 2. Through the real `@fastify/proxy-addr`, which is not resolvable from `apps/api` (it is a
 *    dependency of `fastify` only, and no dependency is added): a bare Fastify instance built
 *    with `trustProxy: createTrustProxy(...)`, reached with `inject` and `remoteAddress`
 *    (no listener), reports `request.ip`. This is the walk the spec scenarios describe; the
 *    `createApp` wiring is task 3.3's `trust-proxy.http.int.test.ts`.
 *
 * ## Decisions this test pins (beyond the task's list)
 *
 * - `cidrs` holds blocks in `address/prefix` form, as `loadConfig` stores them, and a bare
 *   address (no prefix) is also accepted as a `/32` or `/128` (D2: "a bare address is
 *   accepted as a `/32` or `/128`").
 * - A value that is not an IP address (a forwarded header is attacker-controlled text) is
 *   never trusted, and the function does not throw on it (fail closed).
 * - A non-mapped IPv6 address is not matched against an IPv4 block (`::1` is not
 *   `127.0.0.1/32`).
 *
 * ## Production symbols expected (the red phase)
 *
 * - `createTrustProxy(options: { readonly hops: number; readonly cidrs: readonly string[] }):
 *   (address: string, hopIndex: number) => boolean`, exported from `./trust-proxy.js`
 *   (`apps/api/src/trust-proxy.ts`).
 *
 * ## Why this fails right now
 *
 * `apps/api/src/trust-proxy.ts` does not exist, so the import fails to resolve.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { createTrustProxy } from './trust-proxy.js';

type TrustProxyOptions = Parameters<typeof createTrustProxy>[0];

/** The ingress range of the spec scenarios. */
const INGRESS = ['10.0.0.0/16'] as const;

/**
 * Resolves `request.ip` through Fastify's real `proxy-addr` walk: the socket peer is
 * `remoteAddress`, and `forwardedFor` (when given) is the `X-Forwarded-For` header.
 */
async function resolveIp(
  options: TrustProxyOptions,
  remoteAddress: string,
  forwardedFor?: string,
): Promise<{ readonly ip: string; readonly ips: readonly string[] }> {
  const app = Fastify({ logger: false, trustProxy: createTrustProxy(options) });
  app.get('/ip', (request) => ({ ip: request.ip, ips: request.ips ?? [] }));
  try {
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress,
      ...(forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } }),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ ip: string; ips: string[] }>();
  } finally {
    await app.close();
  }
}

describe('createTrustProxy, called the way proxy-addr calls it', () => {
  describe('a peer outside the range', () => {
    it('does not trust a socket peer outside the CIDRs at hop 0', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: INGRESS });

      expect(trust('203.0.113.7', 0)).toBe(false);
      expect(trust('10.1.0.1', 0)).toBe(false);
      expect(trust('127.0.0.1', 0)).toBe(false);
    });

    it('does not trust an address outside the CIDRs at a hop inside the count', () => {
      const trust = createTrustProxy({ hops: 2, cidrs: INGRESS });

      expect(trust('198.51.100.1', 1)).toBe(false);
    });
  });

  describe('a trusted peer', () => {
    it('trusts a socket peer inside the CIDRs at hop 0', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: INGRESS });

      expect(trust('10.0.4.2', 0)).toBe(true);
      expect(trust('10.0.0.0', 0)).toBe(true);
      expect(trust('10.0.255.255', 0)).toBe(true);
    });

    it('trusts an address inside any of several CIDRs', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: ['10.0.0.0/16', '192.168.10.0/24'] });

      expect(trust('10.0.4.2', 0)).toBe(true);
      expect(trust('192.168.10.77', 0)).toBe(true);
      expect(trust('192.168.11.77', 0)).toBe(false);
    });
  });

  describe('more forwarded values than hops', () => {
    it('does not trust hop 1 with one hop configured, even inside the CIDRs', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: INGRESS });

      expect(trust('10.0.4.2', 0)).toBe(true);
      expect(trust('10.0.4.3', 1)).toBe(false);
      expect(trust('10.0.4.3', 2)).toBe(false);
    });

    it('trusts exactly the hops below the configured count', () => {
      const trust = createTrustProxy({ hops: 2, cidrs: INGRESS });

      expect(trust('10.0.4.2', 0)).toBe(true);
      expect(trust('10.0.4.3', 1)).toBe(true);
      expect(trust('10.0.4.4', 2)).toBe(false);
    });

    it('stops at the maximum count of five hops', () => {
      const trust = createTrustProxy({ hops: 5, cidrs: INGRESS });

      for (const hopIndex of [0, 1, 2, 3, 4]) {
        expect(trust('10.0.4.2', hopIndex)).toBe(true);
      }
      expect(trust('10.0.4.2', 5)).toBe(false);
      expect(trust('10.0.4.2', 6)).toBe(false);
    });
  });

  describe('an IPv4-mapped IPv6 peer', () => {
    it('matches `::ffff:127.0.0.1` against an IPv4 range', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: ['127.0.0.1/32'] });

      expect(trust('::ffff:127.0.0.1', 0)).toBe(true);
      expect(trust('127.0.0.1', 0)).toBe(true);
      expect(trust('::ffff:127.0.0.2', 0)).toBe(false);
    });

    it('matches a mapped peer against a wider IPv4 range, and refuses one outside it', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: INGRESS });

      expect(trust('::ffff:10.0.4.2', 0)).toBe(true);
      expect(trust('::ffff:203.0.113.7', 0)).toBe(false);
    });

    it('still applies the hop count to a mapped address', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: ['127.0.0.1/32'] });

      expect(trust('::ffff:127.0.0.1', 1)).toBe(false);
    });

    it('does not match a non-mapped IPv6 address against an IPv4 range', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: ['127.0.0.1/32'] });

      expect(trust('::1', 0)).toBe(false);
    });
  });

  describe('an IPv6 range', () => {
    it('trusts an IPv6 peer inside an IPv6 block and refuses one outside it', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: ['fd00::/8'] });

      expect(trust('fd12:3456:789a::1', 0)).toBe(true);
      expect(trust('fe80::1', 0)).toBe(false);
      expect(trust('2001:db8::1', 0)).toBe(false);
    });

    it('does not trust an IPv4 peer against an IPv6-only list', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: ['fd00::/8'] });

      expect(trust('10.0.4.2', 0)).toBe(false);
    });

    it('applies the hop count to an IPv6 peer', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: ['fd00::/8'] });

      expect(trust('fd00::2', 1)).toBe(false);
    });

    it('honours the CI values, IPv4 and IPv6 loopback together', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: ['127.0.0.1/32', '::1/128'] });

      expect(trust('127.0.0.1', 0)).toBe(true);
      expect(trust('::1', 0)).toBe(true);
      expect(trust('::ffff:127.0.0.1', 0)).toBe(true);
      expect(trust('127.0.0.2', 0)).toBe(false);
      expect(trust('::2', 0)).toBe(false);
    });
  });

  describe('bare-address entries', () => {
    it('treats a bare IPv4 address as a /32', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: ['10.0.4.2'] });

      expect(trust('10.0.4.2', 0)).toBe(true);
      expect(trust('::ffff:10.0.4.2', 0)).toBe(true);
      expect(trust('10.0.4.3', 0)).toBe(false);
    });

    it('treats a bare IPv6 address as a /128', () => {
      const trust = createTrustProxy({ hops: 1, cidrs: ['::1'] });

      expect(trust('::1', 0)).toBe(true);
      expect(trust('::2', 0)).toBe(false);
    });
  });

  describe('a value that is not an IP address', () => {
    it('never trusts it and does not throw', () => {
      const trust = createTrustProxy({ hops: 2, cidrs: INGRESS });

      for (const value of ['garbage', '', '10.0.4', '10.0.4.2.1', 'unknown', '10.0.0.0/16']) {
        expect(trust(value, 0)).toBe(false);
        expect(trust(value, 1)).toBe(false);
      }
    });
  });
});

describe('createTrustProxy, through Fastify and proxy-addr', () => {
  it('A spoofed forwarded address from an untrusted peer is ignored', async () => {
    // GIVEN the platform trusts one hop from the range 10.0.0.0/16
    // WHEN a request arrives from the peer 203.0.113.7 with X-Forwarded-For: 198.51.100.1
    const result = await resolveIp({ hops: 1, cidrs: INGRESS }, '203.0.113.7', '198.51.100.1');

    // THEN the request is keyed on 203.0.113.7
    expect(result.ip).toBe('203.0.113.7');
    expect(result.ips).toStrictEqual(['203.0.113.7']);
  });

  it('A spoofed forwarded address never moves the key off an untrusted peer', async () => {
    // "exhausting a per-address limit with varying forwarded values still limits that peer"
    const keys = new Set<string>();
    for (const forwarded of ['198.51.100.1', '198.51.100.2', '10.0.4.3', '127.0.0.1']) {
      keys.add((await resolveIp({ hops: 1, cidrs: INGRESS }, '203.0.113.7', forwarded)).ip);
    }

    expect([...keys]).toStrictEqual(['203.0.113.7']);
  });

  it('A forwarded address from the trusted ingress is used', async () => {
    // GIVEN the platform trusts one hop from the range 10.0.0.0/16
    // WHEN a request arrives from the peer 10.0.4.2 with X-Forwarded-For: 198.51.100.1
    const result = await resolveIp({ hops: 1, cidrs: INGRESS }, '10.0.4.2', '198.51.100.1');

    // THEN the request is keyed on 198.51.100.1
    expect(result.ip).toBe('198.51.100.1');
  });

  it('Extra hops beyond the configured count are not trusted', async () => {
    // GIVEN the platform trusts one hop from the range 10.0.0.0/16
    // WHEN a request arrives from the peer 10.0.4.2 with
    //      X-Forwarded-For: 198.51.100.9, 10.0.4.3, 198.51.100.1
    const result = await resolveIp(
      { hops: 1, cidrs: INGRESS },
      '10.0.4.2',
      '198.51.100.9, 10.0.4.3, 198.51.100.1',
    );

    // THEN the request is keyed on 198.51.100.1, the right-most forwarded value,
    // and never on an address further left
    expect(result.ip).toBe('198.51.100.1');
    expect(result.ips).not.toContain('10.0.4.3');
    expect(result.ips).not.toContain('198.51.100.9');
  });

  it('does not skip a second in-range forwarded value beyond one hop', async () => {
    // The right-most forwarded value is inside the range, so only the hop count stops the walk.
    const result = await resolveIp(
      { hops: 1, cidrs: INGRESS },
      '10.0.4.2',
      '198.51.100.9, 10.0.4.3',
    );

    expect(result.ip).toBe('10.0.4.3');
    expect(result.ips).not.toContain('198.51.100.9');
  });

  it('skips two in-range hops when two are configured', async () => {
    const result = await resolveIp(
      { hops: 2, cidrs: INGRESS },
      '10.0.4.2',
      '198.51.100.9, 10.0.4.3',
    );

    expect(result.ip).toBe('198.51.100.9');
  });

  it('keys on the peer when a trusted peer sends no forwarded header', async () => {
    const result = await resolveIp({ hops: 1, cidrs: INGRESS }, '10.0.4.2');

    expect(result.ip).toBe('10.0.4.2');
  });

  it('reads the forwarded value of an IPv4-mapped IPv6 peer inside an IPv4 range', async () => {
    const result = await resolveIp(
      { hops: 1, cidrs: ['127.0.0.1/32'] },
      '::ffff:127.0.0.1',
      '198.51.100.1',
    );

    expect(result.ip).toBe('198.51.100.1');
  });

  it('ignores the forwarded value of an IPv4-mapped IPv6 peer outside the range', async () => {
    const result = await resolveIp(
      { hops: 1, cidrs: INGRESS },
      '::ffff:203.0.113.7',
      '198.51.100.1',
    );

    expect(result.ip).toBe('::ffff:203.0.113.7');
  });

  it('reads the forwarded value of an IPv6 peer inside an IPv6 range', async () => {
    const result = await resolveIp({ hops: 1, cidrs: ['fd00::/8'] }, 'fd00::2', '198.51.100.1');

    expect(result.ip).toBe('198.51.100.1');
  });

  it('ignores the forwarded value of an IPv6 peer outside an IPv6 range', async () => {
    const result = await resolveIp({ hops: 1, cidrs: ['fd00::/8'] }, '2001:db8::1', '198.51.100.1');

    expect(result.ip).toBe('2001:db8::1');
  });

  it('reads the forwarded value of a peer listed as a bare address', async () => {
    const trusted = await resolveIp({ hops: 1, cidrs: ['10.0.4.2'] }, '10.0.4.2', '198.51.100.1');
    const neighbour = await resolveIp({ hops: 1, cidrs: ['10.0.4.2'] }, '10.0.4.3', '198.51.100.1');

    expect(trusted.ip).toBe('198.51.100.1');
    expect(neighbour.ip).toBe('10.0.4.3');
  });

  it('keys on the trusted peer when the forwarded value is not an address', async () => {
    const result = await resolveIp(
      { hops: 2, cidrs: INGRESS },
      '10.0.4.2',
      '198.51.100.9, garbage',
    );

    expect(result.ip).toBe('garbage');
    expect(result.ips).not.toContain('198.51.100.9');
  });
});
