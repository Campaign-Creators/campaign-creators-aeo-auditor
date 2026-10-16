import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));
vi.mock('node:dns', async (orig) => {
  const real = await orig<typeof import('node:dns')>();
  return { ...real, default: { ...real, lookup: dnsLookupMock }, lookup: dnsLookupMock };
});

import {
  isBlockedHost,
  isFetchableUrl,
  isPrivateAddress,
  guardedLookup,
  safeFetch,
  BlockedUrlError,
} from './safeFetch';

const PRIVATE_URLS = [
  'http://127.0.0.1/',
  'http://10.0.0.8/',
  'http://172.20.1.1/',
  'http://192.168.1.1/',
  'http://169.254.169.254/',
  'http://localhost/',
  'http://localhost./',
  'http://localhost../',
  'http://127.0.0.1../',
  'http://app.localhost/',
  'http://[::1]/',
  'http://[fd00::1]/',
  'http://[fe80::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://0.0.0.0/',
  'http://2130706433/',
  'http://intranet/',
  'http://printer.local/',
  'http://db.internal/',
];

describe('isBlockedHost / isFetchableUrl', () => {
  it.each(PRIVATE_URLS)('refuses %s', (url) => {
    expect(isBlockedHost(new URL(url).hostname)).toBe(true);
    expect(isFetchableUrl(url)).toBe(false);
  });

  it('allows a public hostname over http and https', () => {
    expect(isFetchableUrl('https://example.com/page')).toBe(true);
    expect(isFetchableUrl('http://www.example.org/')).toBe(true);
  });

  it('refuses non-http schemes and unparseable input', () => {
    expect(isFetchableUrl('file:///etc/hosts')).toBe(false);
    expect(isFetchableUrl('ftp://example.com/')).toBe(false);
    expect(isFetchableUrl('not a url')).toBe(false);
  });
});

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('safeFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('never fetches a blocked starting URL', async () => {
    await expect(safeFetch('http://127.0.0.1/', { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows redirects manually and returns the final response', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('/next', 301))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await safeFetch('https://example.com/start', { timeoutMs: 1000 });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://example.com/start',
      'https://example.com/next',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.redirect).toBe('manual');
    }
  });

  it.each(PRIVATE_URLS)('refuses a redirect hop to %s without fetching it', async (target) => {
    fetchMock.mockResolvedValueOnce(redirect(target));

    await expect(
      safeFetch('https://example.com/start', { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a blocked host on a later hop, not just the first', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://www.example.com/a'))
      .mockResolvedValueOnce(redirect('http://10.1.2.3/b'));

    await expect(
      safeFetch('https://example.com/', { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops after the hop limit', async () => {
    fetchMock.mockImplementation(async () => redirect('https://example.com/loop'));

    await expect(
      safeFetch('https://example.com/', { timeoutMs: 1000, maxRedirects: 3 }),
    ).rejects.toThrow(/redirect/i);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

/* Names are checked above; these specs cover what a public-looking name resolves to. The
   resolver is mocked, so no real DNS query is made. */
describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.4.5.6', '172.16.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1',
  ])('treats %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:93.184.216.34'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it('treats anything that is not an IP address as private', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

type LookupImpl = (h: string, o: unknown, cb: (...a: unknown[]) => void) => void;
const resolvesTo =
  (addresses: Array<{ address: string; family: number }>): LookupImpl =>
  (_h, _o, cb) =>
    cb(null, addresses);

describe('guardedLookup', () => {
  const lookupWith = (addresses: Array<{ address: string; family: number }>) =>
    new Promise<{ err: unknown; result: unknown }>((resolve) => {
      dnsLookupMock.mockImplementation(resolvesTo(addresses));
      guardedLookup('site.example', { all: true }, (err: unknown, result: unknown) =>
        resolve({ err, result }),
      );
    });

  beforeEach(() => {
    dnsLookupMock.mockReset();
  });

  it('passes public addresses through', async () => {
    const { err, result } = await lookupWith([{ address: '93.184.216.34', family: 4 }]);
    expect(err).toBeNull();
    expect(result).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses a name that resolves to a private address', async () => {
    const { err } = await lookupWith([{ address: '10.0.0.7', family: 4 }]);
    expect(err).toBeInstanceOf(BlockedUrlError);
  });

  it('refuses a name when any of its addresses is private', async () => {
    const { err } = await lookupWith([
      { address: '93.184.216.34', family: 4 },
      { address: 'fd00::7', family: 6 },
    ]);
    expect(err).toBeInstanceOf(BlockedUrlError);
  });

  it('returns a single address when the caller did not ask for all', async () => {
    dnsLookupMock.mockImplementation(resolvesTo([{ address: '93.184.216.34', family: 4 }]));
    const got = await new Promise<unknown[]>((resolve) =>
      guardedLookup('site.example', {}, (...args: unknown[]) => resolve(args)),
    );
    expect(got).toEqual([null, '93.184.216.34', 4]);
  });
});

describe('safeFetch connects only to checked addresses', () => {
  it('passes the guarded dispatcher on every hop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect('/next'))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await safeFetch('https://example.com/', { timeoutMs: 1000 });

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.dispatcher).toBeDefined();
    }
  });

  it('refuses, over a real connection, a public-looking name that resolves to loopback', async () => {
    vi.unstubAllGlobals();
    const http = await import('node:http');
    let hits = 0;
    const server = http.createServer((_q, r) => {
      hits++;
      r.end('reached');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as { port: number };
    dnsLookupMock.mockImplementation(resolvesTo([{ address: '127.0.0.1', family: 4 }]));
    try {
      const err = await safeFetch(`http://site.example:${port}/`, { timeoutMs: 3000 }).then(
        () => null,
        (e: unknown) => e,
      );
      // The refusal must come from the guard, not from the name failing to resolve.
      const chain: unknown[] = [];
      for (let e = err; e; e = (e as { cause?: unknown }).cause) chain.push(e);
      expect(chain.some((e) => e instanceof BlockedUrlError)).toBe(true);
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });
});
