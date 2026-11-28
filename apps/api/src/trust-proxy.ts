/**
 * The proxy trust function Fastify accepts as `trustProxy` (048 design D2, Q6).
 *
 * `proxy-addr` calls it with hop 0 as the socket peer, then walks `X-Forwarded-For` from the
 * right and stops at the first untrusted address. Trusting a hop only when it is below the
 * configured count and inside the configured blocks means a peer outside the blocks never
 * has its header read, and at most `hops` forwarded entries are ever skipped.
 */
import { BlockList, isIP } from 'node:net';

export interface TrustProxyOptions {
  /** How many hops, counting the socket peer as hop 0, may be trusted. */
  readonly hops: number;
  /** IPv4 or IPv6 blocks in `address/prefix` form; a bare address is a `/32` or `/128`. */
  readonly cidrs: readonly string[];
}

/**
 * The list kept under `NODE_ENV=test` when neither variable is set (048 D2): the existing
 * suites inject from the loopback peer with a random `X-Forwarded-For`.
 */
export const TEST_TRUST_PROXY = ['loopback', 'linklocal', 'uniquelocal'] as const;

/** What `createApp` hands Fastify: the configured function, or the test list. */
export type TrustProxy = ((address: string, hopIndex: number) => boolean) | typeof TEST_TRUST_PROXY;

/** The dotted form of an IPv4-mapped IPv6 address, for example `::ffff:127.0.0.1`. */
const IPV4_MAPPED = /^::ffff:(?<ipv4>\d{1,3}(?:\.\d{1,3}){3})$/i;

type Family = 'ipv4' | 'ipv6';

function familyOf(address: string): Family | undefined {
  switch (isIP(address)) {
    case 4:
      return 'ipv4';
    case 6:
      return 'ipv6';
    default:
      return undefined;
  }
}

/**
 * Builds the block list once. The entries come from `loadConfig`, which already validated
 * them, so a malformed entry here is a programming error; it throws without echoing it.
 */
function buildBlockList(cidrs: readonly string[]): BlockList {
  const blocks = new BlockList();
  for (const cidr of cidrs) {
    const [address = '', prefix, ...rest] = cidr.split('/');
    const family = familyOf(address);
    if (
      family === undefined ||
      rest.length > 0 ||
      (prefix !== undefined && !/^\d{1,3}$/.test(prefix))
    ) {
      throw new Error('createTrustProxy: a CIDR block is malformed.');
    }
    const bits = prefix === undefined ? (family === 'ipv4' ? 32 : 128) : Number(prefix);
    try {
      blocks.addSubnet(address, bits, family);
    } catch {
      throw new Error('createTrustProxy: a CIDR block is malformed.');
    }
  }
  return blocks;
}

/**
 * Returns `(address, hopIndex) => boolean`: true only when `hopIndex < hops` and the address
 * (an IPv4-mapped IPv6 address reduced to its IPv4 form first) is inside one of the blocks.
 * A value that is not an IP address is never trusted, and the function never throws on it.
 */
export function createTrustProxy(
  options: TrustProxyOptions,
): (address: string, hopIndex: number) => boolean {
  const { hops } = options;
  const blocks = buildBlockList(options.cidrs);

  return (address, hopIndex) => {
    if (!(hopIndex < hops)) {
      return false;
    }
    const candidate = IPV4_MAPPED.exec(address)?.groups?.ipv4 ?? address;
    const family = familyOf(candidate);
    if (family === undefined) {
      return false;
    }
    try {
      return blocks.check(candidate, family);
    } catch {
      return false;
    }
  };
}
