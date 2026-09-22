import { describe, it, expect, beforeEach, vi } from 'vitest';

const { rateLimitMock, supabaseInsertMock } = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  supabaseInsertMock: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: rateLimitMock,
  /* getClientIp moved into this module so both rate-limited routes bucket callers
     identically; the route imports it from here now. */
  getClientIp: () => '203.0.113.7',
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      insert: (...args: unknown[]) => {
        supabaseInsertMock(...args);
        return {
          select: () => ({
            single: async () => supabaseInsertMock.mock.results.at(-1)!.value,
          }),
        };
      },
    }),
  }),
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/audit/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  vi.resetModules();
  rateLimitMock.mockReset();
  supabaseInsertMock.mockReset();
  rateLimitMock.mockResolvedValue({ limited: false });
  supabaseInsertMock.mockReturnValue({ data: { id: 'audit-123' }, error: null });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
  process.env.INTERNAL_CRAWLER_SECRET = 'secret';
  process.env.RATE_LIMIT_MAX = '5';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(null, { status: 202 })),
  );
});

describe('POST /api/audit/start', () => {
  it('returns 201 with auditId for a valid URL', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ url: 'https://example.com/some/path?q=1' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ auditId: 'audit-123' });
    expect(supabaseInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com', status: 'pending' }),
    );
  });

  it('rejects private IP hostnames with 400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ url: 'http://10.0.0.1/admin' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/private\/local/);
  });

  it('rejects localhost with 400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ url: 'http://localhost:3000/' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/private\/local/);
  });

  it('rejects malformed URLs with 400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ url: 'not-a-url' }));
    expect(res.status).toBe(400);
  });

  it('returns 429 with Retry-After when rate-limited', async () => {
    rateLimitMock.mockResolvedValueOnce({ limited: true });
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ url: 'https://example.com' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    const json = await res.json();
    expect(json).toEqual({ error: 'Rate limit exceeded', retryAfterSeconds: 3600 });
  });

  it('returns 500 when Supabase INSERT fails', async () => {
    supabaseInsertMock.mockReturnValueOnce({ data: null, error: { message: 'boom' } });
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ url: 'https://example.com' }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: 'Database error' });
  });
});
