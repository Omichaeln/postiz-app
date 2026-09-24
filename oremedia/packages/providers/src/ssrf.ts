import dns from 'node:dns';
import net from 'node:net';
import { Agent, type Dispatcher } from 'undici';

/**
 * Spec 18 / 20.2: SSRF-safe outbound dispatcher with pinned DNS. Every resolved address is checked and the
 * connection uses exactly the checked addresses (no TOCTOU between validation and connect). There is NO flag
 * that disables this in the hosted product (Appendix A).
 */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] as number) << 24) + ((p[1] as number) << 16) + ((p[2] as number) << 8) + (p[3] as number);
}
const inCidr4 = (ip: string, cidr: string): boolean => {
  const [base, bits] = cidr.split('/') as [string, string];
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
};
const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
];

/** The 16 bytes of an IPv6 address in any textual form (compressed, expanded, dotted IPv4 tail); null if invalid. */
function ipv6Bytes(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, ''); // zone id
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (net.isIP(dotted[1] as string) !== 4) return null;
    const v4 = ipv4ToInt(dotted[1] as string) >>> 0;
    text = `${text.slice(0, dotted.index)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] as string);
  const tail = halves.length === 2 ? parse(halves[1] as string) : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

const v4FromBytes = (b: number[]): string => b.join('.');

export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED_V4.some((c) => inCidr4(ip, c));
  if (family === 6) {
    const b = ipv6Bytes(ip);
    if (!b) return true;
    const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
    if (zero(0, 16)) return true; // :: unspecified
    if (zero(0, 15) && b[15] === 1) return true; // ::1 loopback
    // Embedded IPv4, in any notation (WHATWG URL serialises ::ffff:169.254.169.254 as ::ffff:a9fe:a9fe):
    // v4-mapped ::ffff:0:0/96, v4-compatible ::/96, SIIT ::ffff:0:0:0/96 and 6to4 2002::/16 are judged by the
    // IPv4 address they carry; NAT64 (64:ff9b::/32 prefixes) and Teredo are refused outright.
    if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIp(v4FromBytes(b.slice(12, 16)));
    if (zero(0, 12)) return isBlockedIp(v4FromBytes(b.slice(12, 16)));
    if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12))
      return isBlockedIp(v4FromBytes(b.slice(12, 16)));
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true; // NAT64 can embed private v4
    if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIp(v4FromBytes(b.slice(2, 6)));
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // Teredo 2001::/32
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation 2001:db8::/32
    if (b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0x80) return true; // link-local fe80::/10
    if (b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0xc0) return true; // site-local fec0::/10 (deprecated)
    if (((b[0] as number) & 0xfe) === 0xfc) return true; // unique local fc00::/7 (includes fd00:ec2::254)
    if (b[0] === 0xff) return true; // multicast
    return false;
  }
  return true; // not an IP at all: refuse
}

export class BlockedAddressError extends Error {
  constructor(target: string) {
    super(`Blocked address: ${target}`);
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** Pinned lookup: resolves, checks every address, and hands the same set to the connector. */
export function ssrfSafeLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    callback(new BlockedAddressError(hostname), '', 0);
    return;
  }
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      callback(new BlockedAddressError(hostname), '', 0);
      return;
    }
    const family = net.isIP(hostname);
    if (options.all) callback(null, [{ address: hostname, family }], family);
    else callback(null, hostname, family);
    return;
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0) {
      callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    for (const entry of list) {
      if (isBlockedIp(entry.address)) {
        callback(new BlockedAddressError(`${hostname} → ${entry.address}`), '', 0);
        return;
      }
    }
    if (options.all) callback(null, list, 0);
    else callback(null, (list[0] as dns.LookupAddress).address, (list[0] as dns.LookupAddress).family);
  });
}

export interface SafeDispatcherOptions {
  /** Tests only: allow 127.0.0.1 targets. Refused when NODE_ENV=production. */
  insecureAllowLoopback?: boolean;
}

export function ssrfSafeDispatcher(opts: SafeDispatcherOptions = {}): Dispatcher {
  if (opts.insecureAllowLoopback && process.env['NODE_ENV'] === 'production')
    throw new Error('insecureAllowLoopback is not permitted in production');
  const lookup = opts.insecureAllowLoopback
    ? (hostname: string, options: dns.LookupOptions, cb: LookupCallback) => {
        if (hostname === '127.0.0.1' || hostname === 'localhost') {
          if (options.all) cb(null, [{ address: '127.0.0.1', family: 4 }], 4);
          else cb(null, '127.0.0.1', 4);
          return;
        }
        ssrfSafeLookup(hostname, options, cb);
      }
    : ssrfSafeLookup;
  return new Agent({ connect: { lookup: lookup as never, timeout: 10_000 } });
}

/** URL policy for provider calls: https only, no credentials in the URL, no blocked hostnames. */
export function assertSafeUrl(url: string, opts: SafeDispatcherOptions = {}): URL {
  const u = new URL(url);
  // An IPv6 literal keeps its brackets in URL.hostname; the checks need the bare address. A literal address is
  // connected to without a DNS lookup, so this is the only place it is ever checked.
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  const loopbackOk = opts.insecureAllowLoopback && (host === '127.0.0.1' || host === 'localhost');
  if (u.protocol !== 'https:' && !(loopbackOk && u.protocol === 'http:'))
    throw new BlockedAddressError(`${u.protocol} is not allowed`);
  if (u.username || u.password) throw new BlockedAddressError('credentials in URL');
  if (!loopbackOk && (BLOCKED_HOSTNAMES.has(host.toLowerCase()) || (net.isIP(host) && isBlockedIp(host))))
    throw new BlockedAddressError(host);
  return u;
}
