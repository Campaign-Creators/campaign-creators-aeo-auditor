/**
 * Outbound fetches for URLs that come from the audited site.
 *
 * The start route checks the visitor's URL once, but the crawler then fetches URLs the
 * site itself supplies: robots sitemap hints, sitemap entries, internal links and
 * redirect targets. Every one of those goes through `safeFetch`, which re-checks the
 * host before each request and follows redirects by hand so each hop is checked too.
 *
 * A name can look public and still resolve to a private address, so the connection itself
 * goes through `guardedLookup`: the addresses are checked at connect time, on the same
 * resolution the socket then uses.
 */
import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export const MAX_REDIRECTS = 5;

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/**
 * True for any host the crawler must not reach: localhost names, internal-only suffixes,
 * single-label names, and every IP literal. Public sites are reached by hostname, so IP
 * literals are refused outright rather than range-checked.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

  // Empty names and empty labels are never a public site.
  if (!h || h.includes('..')) return true;

  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') {
    return true;
  }

  if (h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }

  // Every IPv6 literal, bracketed or not.
  if (hostname.startsWith('[') || h.includes(':')) {
    return true;
  }

  // Every IPv4 literal. URL parsing has already normalised short and numeric forms.
  if (IPV4_RE.test(h)) {
    return true;
  }

  // Purely numeric names that did not normalise into an address.
  if (/^\d+(\.\d+)*$/.test(h)) {
    return true;
  }

  // Single-label names (no TLD) only resolve on private networks.
  if (!h.includes('.')) {
    return true;
  }

  return false;
}

const PRIVATE_RANGES = (() => {
  const list = new net.BlockList();
  for (const [prefix, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ] as const) list.addSubnet(prefix, bits, 'ipv4');
  for (const [prefix, bits] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32],
    ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ] as const) list.addSubnet(prefix, bits, 'ipv6');
  return list;
})();

/** True unless `ip` is a public unicast address. Non-addresses count as private. */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return PRIVATE_RANGES.check(ip, 'ipv4');
  if (family !== 6) return true;
  // An IPv4-mapped IPv6 address is judged by the IPv4 address inside it.
  const mapped = ip.toLowerCase().match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    const v4 = mapped[1] ?? [mapped[2], mapped[3]]
      .flatMap((h) => { const n = Number.parseInt(h, 16); return [n >> 8, n & 255]; })
      .join('.');
    return PRIVATE_RANGES.check(v4, 'ipv4');
  }
  return PRIVATE_RANGES.check(ip, 'ipv6');
}

type LookupCallback = (
  err: NodeJS.ErrnoException | Error | null,
  address?: string | dns.LookupAddress[],
  family?: number,
) => void;

/** `dns.lookup` for the crawler's sockets: fails if any resolved address is private. */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new BlockedUrlError('Refusing to connect to a non-public address'));
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

let dispatcher: Agent | undefined;
const guardedDispatcher = (): Agent =>
  (dispatcher ??= new Agent({ connect: { lookup: guardedLookup as never } }));

/** http(s) URL whose host passes `isBlockedHost`. */
export function isFetchableUrl(input: string | URL): boolean {
  let u: URL;
  try {
    u = new URL(String(input));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !isBlockedHost(u.hostname);
}

function assertFetchable(url: string): void {
  if (!isFetchableUrl(url)) {
    throw new BlockedUrlError('Refusing to fetch a non-public URL');
  }
}

/**
 * `fetch` with a timeout that covers every hop, redirects followed manually up to
 * `maxRedirects`, and the host guard applied before each request.
 */
export async function safeFetch(
  url: string,
  { timeoutMs, maxRedirects = MAX_REDIRECTS }: { timeoutMs: number; maxRedirects?: number },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      assertFetchable(current);
      const res = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        // Node's fetch accepts an undici dispatcher; the DOM RequestInit type doesn't list it.
        dispatcher: guardedDispatcher(),
      } as RequestInit);

      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) {
        return res;
      }

      await res.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) {
        throw new Error(`Too many redirects (limit ${maxRedirects})`);
      }
      current = new URL(location, current).toString();
    }
  } finally {
    clearTimeout(timer);
  }
}
