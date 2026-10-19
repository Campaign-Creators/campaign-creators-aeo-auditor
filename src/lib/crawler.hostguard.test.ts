import { describe, it, expect, beforeEach, vi } from 'vitest';

/* Both crawlers (the Inngest job and the fallback crawl route) must check every URL they
   fetch against the private-host guard: the start URL, robots sitemap hints, sitemap
   entries, internal links and every redirect hop. These specs drive each crawler against a
   stubbed network and assert that no blocked host is ever handed to fetch. */

const { captured } = vi.hoisted(() => ({
  captured: { handler: null as null | ((ctx: unknown) => Promise<unknown>) },
}));

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: (ctx: unknown) => Promise<unknown>) => {
      captured.handler = handler;
      return {};
    },
  },
}));

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'update', 'upsert', 'eq', 'select', 'insert']) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve({ data: null, error: null });
  return { createClient: () => chain };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async () => {
        throw new Error('engines are mocked in tests');
      },
    };
  },
}));

vi.mock('@/lib/auditor/ai-probe', () => ({
  probeWithPrompts: vi.fn(async () => null),
  probeOpenAI: vi.fn(async () => null),
  probePerplexity: vi.fn(async () => null),
  probeGoogleAI: vi.fn(async () => null),
  probeClaudeVisibility: vi.fn(async () => null),
}));

const BLOCKED_HOSTS = [
  '127.0.0.1',
  '10.1.2.3',
  '169.254.169.254',
  'localhost',
  '[fd00::1]',
  '[::1]',
];

function html(body: string): Response {
  return new Response(`<html><head><title>t</title></head><body>${body}</body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** A public site whose sitemap, links and redirects all point somewhere private. */
function siteResponder(robotsSitemapHint: string) {
  return async (input: string | URL): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname !== 'example.com') {
      return html('reached a host the crawler should never fetch');
    }
    switch (url.pathname) {
      case '/robots.txt':
        return new Response(`User-agent: *\nAllow: /\nSitemap: ${robotsSitemapHint}\n`, {
          status: 200,
        });
      case '/sitemap.xml':
        return new Response(
          `<urlset>${[
            'https://example.com/redirects',
            'https://example.com/chain',
            ...BLOCKED_HOSTS.map((h) => `http://${h}/from-sitemap`),
          ]
            .map((u) => `<loc>${u}</loc>`)
            .join('')}</urlset>`,
          { status: 200 },
        );
      case '/':
        return html(
          '<a href="/linked">ok</a>' +
            BLOCKED_HOSTS.map((h) => `<a href="http://${h}/from-link">x</a>`).join(''),
        );
      case '/redirects':
        return redirect('http://169.254.169.254/hop');
      case '/chain':
        return redirect('https://example.com/chain-2');
      case '/chain-2':
        return redirect('http://[fd00::1]/hop');
      case '/linked':
        return redirect('http://localhost/hop');
      default:
        return html('');
    }
  };
}

function fetchedHosts(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => new URL(String(c[0])).host);
}

function expectOnlyPublicFetches(fetchMock: ReturnType<typeof vi.fn>): void {
  expect(fetchMock).toHaveBeenCalled();
  expect(new Set(fetchedHosts(fetchMock))).toEqual(new Set(['example.com']));
  for (const [, init] of fetchMock.mock.calls) {
    expect((init as RequestInit | undefined)?.redirect).toBe('manual');
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  captured.handler = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.INTERNAL_CRAWLER_SECRET = 'secret';
});

async function runInngestCrawl(domainUrl: string): Promise<void> {
  await import('@/lib/inngest/functions');
  expect(captured.handler).toBeTypeOf('function');
  const step = {
    run: async (name: string, fn: () => Promise<unknown>) =>
      name === 'crawl-site' ? fn() : undefined,
  };
  try {
    await captured.handler!({
      event: { data: { auditId: '00000000-0000-4000-8000-000000000000', domainUrl } },
      step,
    });
  } catch {
    // later steps are stubbed out; only the crawl's network calls matter here
  }
}

async function runRouteCrawl(domainUrl: string): Promise<void> {
  const { POST } = await import('@/app/api/audit/crawl/route');
  const req = new Request('http://localhost:3000/api/audit/crawl', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ auditId: '00000000-0000-4000-8000-000000000000', domainUrl }),
  }) as unknown as import('next/server').NextRequest;
  await POST(req);
}

describe.each([
  ['inngest run-audit', runInngestCrawl],
  ['fallback crawl route', runRouteCrawl],
])('%s host guard', (_name, crawl) => {
  it(
    'never fetches private sitemap entries, links or redirect targets',
    async () => {
      fetchMock = vi.fn(siteResponder('https://example.com/sitemap.xml'));
      vi.stubGlobal('fetch', fetchMock);

      await crawl('https://example.com');

      expectOnlyPublicFetches(fetchMock);
      const paths = fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname);
      expect(paths).toEqual(expect.arrayContaining(['/redirects', '/chain', '/chain-2']));
    },
    30_000,
  );

  it(
    'never fetches a sitemap hint that points at a private host',
    async () => {
      fetchMock = vi.fn(siteResponder('http://10.0.0.5/sitemap.xml'));
      vi.stubGlobal('fetch', fetchMock);

      await crawl('https://example.com');

      expectOnlyPublicFetches(fetchMock);
    },
    30_000,
  );

  it(
    'finishes when a page body stops sending',
    async () => {
      let cancelled = false;
      const site = siteResponder('https://example.com/sitemap.xml');
      fetchMock = vi.fn(async (input: string | URL) => {
        if (new URL(String(input)).pathname !== '/') return site(input);
        // One chunk, then silence. A stall rather than an endless body: without the read
        // timeout this spec hangs and fails cleanly, instead of buffering until memory runs out.
        let sent = false;
        const stalled = new ReadableStream<Uint8Array>({
          pull: (c) => {
            if (sent) return new Promise(() => {});
            sent = true;
            c.enqueue(new TextEncoder().encode('<html><title>t</title>'));
          },
          cancel: () => {
            cancelled = true;
          },
        });
        return new Response(stalled, { headers: { 'content-type': 'text/html' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      await crawl('https://example.com');

      // The read timed out and let go of the connection, rather than the stream ending.
      expect(cancelled).toBe(true);
    },
    30_000,
  );

  it('never fetches a private start URL', async () => {
    fetchMock = vi.fn(siteResponder('https://example.com/sitemap.xml'));
    vi.stubGlobal('fetch', fetchMock);

    await crawl('http://127.0.0.1');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
