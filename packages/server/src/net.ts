import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * True for addresses a public audit service must never be pointed at: loopback, private ranges,
 * link-local (including cloud metadata at 169.254.169.254), CGNAT, multicast and reserved space.
 */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return isPrivateV4(address);
  if (!net.isIPv6(address)) return true; // not an IP at all: refuse rather than guess
  const groups = parseIPv6(address.replace(/^\[|\]$/g, ''));
  if (!groups) return true;
  return isPrivateV6(groups);
}

/** Expand any textual IPv6 form (compressed, zone-less, trailing dotted quad) into eight 16-bit groups. */
function parseIPv6(text: string): number[] | undefined {
  let a = text.toLowerCase().split('%')[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const [b0, b1, b2, b3] = dotted.slice(1).map(Number) as [number, number, number, number];
    a = `${a.slice(0, dotted.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const groups = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

const allZero = (groups: number[]) => groups.every((g) => g === 0);

/** First six groups (joined) of the prefixes whose last 32 bits are an IPv4 address: ::/96 compatible, ::ffff:0:0/96 mapped, ::ffff:0:0:0/96 SIIT. */
const V4_EMBEDDING_PREFIXES = new Set(['0:0:0:0:0:0', '0:0:0:0:0:65535', '0:0:0:0:65535:0']);

/** The IPv4 address an IPv6 address tunnels or translates to, if its prefix is one of the embedding formats. */
function embeddedV4(g: number[]): string | undefined {
  const [g0 = 0, g1 = 0, g2 = 0, , , , g6 = 0, g7 = 0] = g;
  if (g0 === 0x2002) return v4FromGroups(g1, g2); // 6to4 embeds the IPv4 address in groups 1-2
  return V4_EMBEDDING_PREFIXES.has(g.slice(0, 6).join(':')) ? v4FromGroups(g6, g7) : undefined;
}

/** Non-embedding IPv6 ranges a public audit service must refuse, as [mask, value] on the first group. */
const BLOCKED_V6_FIRST_GROUP: readonly (readonly [number, number])[] = [
  [0xfe00, 0xfc00], // fc00::/7 unique local
  [0xffc0, 0xfe80], // fe80::/10 link-local
  [0xff00, 0xff00], // ff00::/8 multicast
];

/** Blocked two-group prefixes: 64:ff9b::/32 NAT64 (can reach IPv4 internals), 2001::/32 Teredo, 2001:db8::/32 documentation. */
const BLOCKED_V6_PREFIXES: readonly (readonly [number, number])[] = [
  [0x64, 0xff9b],
  [0x2001, 0],
  [0x2001, 0xdb8],
];

function isPrivateV6(g: number[]): boolean {
  if (allZero(g.slice(0, 7)) && (g[7] ?? 0) <= 1) return true; // :: and ::1
  const v4 = embeddedV4(g);
  if (v4 !== undefined) return isPrivateV4(v4);
  const [g0 = 0, g1 = 0] = g;
  return BLOCKED_V6_FIRST_GROUP.some(([mask, value]) => (g0 & mask) === value) || BLOCKED_V6_PREFIXES.some(([a, b]) => g0 === a && g1 === b);
}

/** Blocked IPv4 ranges as [first octet, min second octet, max second octet]. */
const PRIVATE_V4_RANGES: readonly (readonly [number, number, number])[] = [
  [0, 0, 255], // "this" network
  [10, 0, 255],
  [127, 0, 255], // loopback
  [100, 64, 127], // CGNAT
  [169, 254, 254], // link-local, cloud metadata
  [172, 16, 31],
  [192, 168, 168],
  [192, 0, 0], // IETF protocol assignments
  [198, 18, 19], // benchmarking
];

function isPrivateV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return a >= 224 /* multicast and reserved */ || PRIVATE_V4_RANGES.some(([first, lo, hi]) => a === first && b >= lo && b <= hi);
}

export interface VettedTarget {
  url: string;
  hostname: string;
  /** Resolved public address of the initial host. */
  address: string;
}

/** Validate a user-supplied URL for a public audit service. Throws a user-facing message when refused. */
export async function vetTarget(raw: string, options: { allowPrivate?: boolean } = {}): Promise<VettedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetError('Enter a full URL, including https://');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TargetError('Only http and https URLs can be audited.');
  if (url.username || url.password) throw new TargetError('URLs with credentials are not allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const address = await resolvePublic(hostname, options);
  return { url: url.href, hostname, address };
}

/** Resolve a hostname and refuse it if any address is internal. Returns the address to connect to. */
export async function resolvePublic(hostname: string, options: { allowPrivate?: boolean } = {}): Promise<string> {
  let addresses: string[];
  if (net.isIP(hostname)) addresses = [hostname];
  else {
    try {
      addresses = (await dns.lookup(hostname, { all: true, verbatim: true })).map((r) => r.address);
    } catch {
      throw new TargetError(`Could not resolve ${hostname}.`);
    }
  }
  if (!options.allowPrivate && addresses.some(isPrivateAddress)) {
    throw new TargetError(`${hostname} resolves to a private or internal address, which this service does not audit.`);
  }
  return addresses[0]!;
}

export class TargetError extends Error {}
