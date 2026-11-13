/**
 * The limiter key of a client address (`044` design D16, Q28). An IPv4 address is its own
 * key, an IPv4-mapped IPv6 address (dotted or hex form) is its IPv4 form, and any other
 * IPv6 address is its first 64 bits in expanded form, so one /64 shares a bucket. A zone id
 * is dropped. The key is never logged or exported; the bucket store hashes it.
 */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIPv4(text: string): number[] | undefined {
  const match = IPV4.exec(text);
  if (match === null) {
    return undefined;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/** Eight 16-bit groups of an IPv6 address without zone id. */
function parseIPv6(text: string): number[] {
  const invalid = new Error('Unparseable client address');
  let head = text;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  let embedded: number[] = [];
  if (tail.includes('.')) {
    const octets = parseIPv4(tail);
    if (octets === undefined) {
      throw invalid;
    }
    embedded = [
      ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
      ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
    ];
    head = text.slice(0, lastColon + 1) + '0:0';
  }
  const halves = head.split('::');
  if (halves.length > 2) {
    throw invalid;
  }
  const toGroups = (part: string | undefined): number[] =>
    part === undefined || part === ''
      ? []
      : part.split(':').map((group) => {
          if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
            throw invalid;
          }
          return parseInt(group, 16);
        });
  const left = toGroups(halves[0]);
  const right = toGroups(halves[1]);
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    throw invalid;
  }
  const groups = [
    ...left,
    ...new Array<number>(halves.length === 2 ? missing : 0).fill(0),
    ...right,
  ];
  if (embedded.length === 2) {
    groups.splice(6, 2, ...embedded);
  }
  return groups;
}

/** Pure; throws on a string that is neither an IPv4 nor an IPv6 address. */
export function clientIpKey(address: string): string {
  const withoutZone = address.split('%', 1)[0] ?? '';
  if (parseIPv4(withoutZone) !== undefined) {
    return withoutZone;
  }
  const groups = parseIPv6(withoutZone);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [g6 = 0, g7 = 0] = groups.slice(6);
    return `${String(g6 >> 8)}.${String(g6 & 0xff)}.${String(g7 >> 8)}.${String(g7 & 0xff)}`;
  }
  return groups
    .slice(0, 4)
    .map((g) => g.toString(16).padStart(4, '0'))
    .join(':');
}
