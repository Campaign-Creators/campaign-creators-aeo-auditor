import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isBlockedHost, isFetchableUrl, safeFetch, BlockedUrlError } from './safeFetch';

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
