// The shared crawler: one time budget for the whole crawl, a flag on pages cut at the body
// cap, and the same result whichever path (pipeline or fallback route) runs it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// fetch is stubbed below, so no request leaves the test.
import { crawlSite } from './crawl';
import { MAX_BODY_BYTES } from '@/lib/safeFetch';

function page(body: string): Response {
  return new Response(`<html><head><title>t</title></head><body>${body}</body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

/** A response whose headers never arrive; it ends only when the fetch is aborted. */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('crawlSite budget', () => {
  it('robots and sitemap fetches take their time out of the crawl budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/robots.txt' || path === '/sitemap.xml') return hang(init);
      return page('home');
    }));
    const started = Date.now();
    const r = await crawlSite('https://test-site.example', { maxPages: 5, budgetMs: 400 });
    const took = Date.now() - started;
    // Without the shared budget, the two slow fetches alone take 8 s each.
    expect(took).toBeLessThan(3000);
    expect(r.crawledPages.length).toBeLessThanOrEqual(1);
  });
});

describe('crawlSite truncation flag', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));

  it('flags a page longer than the body cap, and not a normal one', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 10);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/') return page(`<a href="/big">b</a>`);
      if (path === '/big') return page(big);
      return new Response('', { status: 404 });
    }));
    const r = await crawlSite('https://test-site.example', { maxPages: 5, budgetMs: 20_000 });
    const byPath = Object.fromEntries(r.crawledPages.map(p => [new URL(p.url).pathname, p]));
    expect(byPath['/'].truncated).toBeUndefined();
    expect(byPath['/big'].truncated).toBe(true);
  });
});
