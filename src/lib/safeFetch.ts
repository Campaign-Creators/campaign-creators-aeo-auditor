/**
 * Outbound fetches for URLs that come from the audited site.
 *
 * The start route checks the visitor's URL once, but the crawler then fetches URLs the
 * site itself supplies: robots sitemap hints, sitemap entries, internal links and
 * redirect targets. Every one of those goes through `safeFetch`, which re-checks the
 * host before each request and follows redirects by hand so each hop is checked too.
 */

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
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

  if (!h) return true;

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
      const res = await fetch(current, { signal: controller.signal, redirect: 'manual' });

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
