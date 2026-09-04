import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard shared by the API (URL import) and the worker (source download).
 *
 * A URL is only accepted when it is plain http(s), carries no userinfo, uses a
 * conventional web port, and every address its hostname resolves to is a public
 * unicast address. The worker re-runs the check on every redirect hop, so a
 * public host cannot bounce a request into the private network.
 */

/** Ports a legitimate public video source is served from. */
export const ALLOWED_URL_PORTS = new Set([80, 443, 8080, 8443]);

/** Maximum number of redirects the import fetch follows. */
export const MAX_IMPORT_REDIRECTS = 5;

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/* ─── IP classification ──────────────────────────────────── */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** CIDR blocks that must never be reachable from a user-supplied URL. */
const BLOCKED_V4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],          // "this" network
  ['10.0.0.0', 8],         // RFC1918
  ['100.64.0.0', 10],      // CGNAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local (cloud metadata)
  ['172.16.0.0', 12],      // RFC1918
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.88.99.0', 24],     // 6to4 relay anycast
  ['192.168.0.0', 16],     // RFC1918
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved + broadcast
];

function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable → refuse
  for (const [base, bits] of BLOCKED_V4_CIDRS) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return true;
  }
  return false;
}

/** Expand an IPv6 address to its eight 16-bit groups. Returns null when malformed. */
function ipv6Groups(ip: string): number[] | null {
  let address = ip;
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);

  // An embedded IPv4 tail (::ffff:127.0.0.1) becomes two hex groups.
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    address =
      address.slice(0, lastColon + 1) +
      ((v4 >>> 16) & 0xffff).toString(16) +
      ':' +
      (v4 & 0xffff).toString(16);
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : null;
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (rest === null) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

function isPrivateIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups) return true; // unparseable → refuse

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) → judge as IPv4.
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
  if (firstFiveZero && groups[5] === 0xffff) {
    return isPrivateIpv4(v4FromGroups(groups));
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isPrivateIpv4(v4FromGroups(groups));
  }

  const allZeroButLast = groups.slice(0, 7).every((g) => g === 0);
  if (allZeroButLast && (groups[7] === 0 || groups[7] === 1)) return true; // :: and ::1
  if (allZeroButLast) return true;                                        // ::x → IPv4-compatible / reserved

  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) return true; // 100::/64 discard
  if (first === 0x2001 && (groups[1]! & 0xff00) === 0x0000) return true; // 2001:0::/24 (Teredo/ORCHID/doc)
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  return false;
}

function v4FromGroups(groups: number[]): string {
  const high = groups[6]!;
  const low = groups[7]!;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/** True when `ip` is loopback, private, link-local, multicast or otherwise not publicly routable. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true; // not an IP literal → refuse
}

/* ─── URL guard ──────────────────────────────────────────── */

export interface AssertPublicHttpUrlOptions {
  /** Require https (used for webhook targets). */
  requireHttps?: boolean;
  /** Override DNS resolution (tests). */
  resolve?: (hostname: string) => Promise<string[]>;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/** Strip the brackets Node keeps around an IPv6 host in `URL.hostname`. */
function bareHostname(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Validate that `input` points at a public http(s) endpoint.
 *
 * Throws {@link BlockedUrlError} for anything else: non-http(s) schemes, embedded
 * credentials, unusual ports, unresolvable hosts, and hosts that resolve to a
 * private/loopback/link-local/multicast address (IPv4, IPv6 and v4-mapped IPv6).
 *
 * Returns the parsed URL together with the addresses it resolved to.
 */
export async function assertPublicHttpUrl(
  input: string | URL,
  options: AssertPublicHttpUrlOptions = {},
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    throw new BlockedUrlError('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`Unsupported URL scheme "${url.protocol.replace(':', '')}" — use http or https`);
  }
  if (options.requireHttps && url.protocol !== 'https:') {
    throw new BlockedUrlError('URL must use https');
  }
  if (url.username || url.password) {
    throw new BlockedUrlError('URLs with embedded credentials are not allowed');
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_URL_PORTS.has(port)) {
    throw new BlockedUrlError(`Port ${port} is not allowed — use 80, 443, 8080 or 8443`);
  }

  const hostname = bareHostname(url);
  if (!hostname) throw new BlockedUrlError('URL has no host');

  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    const resolver = options.resolve ?? defaultResolve;
    try {
      addresses = await resolver(hostname);
    } catch {
      throw new BlockedUrlError(`Could not resolve host "${hostname}"`);
    }
    if (addresses.length === 0) throw new BlockedUrlError(`Could not resolve host "${hostname}"`);
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedUrlError(
        `Host "${hostname}" resolves to a non-public address (${address}) — refusing to fetch it`,
      );
    }
  }

  return { url, addresses };
}
