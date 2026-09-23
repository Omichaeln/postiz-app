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

export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED_V4.some((c) => inCidr4(ip, c));
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (
      lower.startsWith('fe80:') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    )
      return true; // link-local fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
    if (lower.startsWith('ff')) return true; // multicast
    if (lower.startsWith('fd00:ec2::254')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedIp(mapped[1] as string);
    if (lower.startsWith('64:ff9b:')) return true; // NAT64 range can embed private v4
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
  const loopbackOk = opts.insecureAllowLoopback && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if (u.protocol !== 'https:' && !(loopbackOk && u.protocol === 'http:'))
    throw new BlockedAddressError(`${u.protocol} is not allowed`);
  if (u.username || u.password) throw new BlockedAddressError('credentials in URL');
  if (
    !loopbackOk &&
    (BLOCKED_HOSTNAMES.has(u.hostname.toLowerCase()) || (net.isIP(u.hostname) && isBlockedIp(u.hostname)))
  )
    throw new BlockedAddressError(u.hostname);
  return u;
}
