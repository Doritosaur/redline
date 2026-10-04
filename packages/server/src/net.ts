import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * True for addresses a public audit service must never be pointed at: loopback, private ranges,
 * link-local (including cloud metadata at 169.254.169.254), CGNAT, multicast and reserved space.
 */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return isPrivateV4(address);
  if (!net.isIPv6(address)) return true; // not an IP at all: refuse rather than guess
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPrivateV4(mapped[1]!);
  if (a === '::' || a === '::1') return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    a.startsWith('64:ff9b:') || // NAT64, can reach IPv4 internals
    a.startsWith('2001:db8:') // documentation
  );
}

function isPrivateV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
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
