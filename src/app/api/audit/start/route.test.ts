import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { rateLimitMock, supabaseInsertMock, today } = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  supabaseInsertMock: vi.fn(),
  today: { count: 0, since: '', publicOnly: false },
}));

const { staffMock } = vi.hoisted(() => ({ staffMock: vi.fn(async (): Promise<string | null> => null) }));
vi.mock('@/lib/staff', async (orig) => ({
  ...(await orig<typeof import('@/lib/staff')>()),
  staffEmail: staffMock,
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
      select: () => {
        const result = () => ({ count: today.count, error: null });
        return {
          gte: (_col: string, since: string) => {
            today.since = since;
            const p = Promise.resolve(result());
            return Object.assign(p, {
              is: async (col: string, v: unknown) => {
                if (col === 'requested_by' && v === null) today.publicOnly = true;
                return result();
              },
            });
          },
        };
      },
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

describe('POST /api/audit/start daily cap', () => {
  const GATE_KEYS = ['AEO_GATE_MODE', 'AEO_DAILY_AUDIT_CAP', 'VERCEL_ENV', 'ANTHROPIC_API_KEY', 'AEO_UNLOCK_COOKIE_SECRET'];
  beforeEach(() => {
    today.count = 0;
    Object.assign(process.env, {
      VERCEL_ENV: 'production', ANTHROPIC_API_KEY: 'a', AEO_DAILY_AUDIT_CAP: '3', AEO_UNLOCK_COOKIE_SECRET: 'c',
    });
  });
  afterEach(() => { for (const k of GATE_KEYS) delete process.env[k]; });

  it('enforce: at the cap, refuses with 503 before any write or rate-limit spend', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    today.count = 3;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ url: 'https://example.com' }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('DAILY_CAP');
    expect(supabaseInsertMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(today.since).toMatch(/T00:00:00\.000Z$/);
  });

  it('enforce: below the cap, the audit starts', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    today.count = 2;
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ url: 'https://example.com' }));
    expect(res.status).toBe(201);
  });

  it('staff: at the cap, the audit starts and is marked as a staff audit (AC-019)', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    process.env.AEO_STAFF_EMAILS = 'staff@example.com';
    today.count = 3;
    staffMock.mockResolvedValueOnce('staff@example.com');
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ url: 'https://example.com' }, { authorization: 'Bearer t' }));
    delete process.env.AEO_STAFF_EMAILS;
    expect(res.status).toBe(201);
    expect(supabaseInsertMock).toHaveBeenCalledWith(expect.objectContaining({ requested_by: 'staff' }));
  });

  it('with staff configured, the daily count leaves staff audits out', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    process.env.AEO_STAFF_EMAILS = 'staff@example.com';
    today.publicOnly = false;
    const { POST } = await import('./route');
    await POST(makeRequest({ url: 'https://example.com' }));
    delete process.env.AEO_STAFF_EMAILS;
    expect(today.publicOnly).toBe(true);
    expect(supabaseInsertMock).toHaveBeenCalledWith(expect.not.objectContaining({ requested_by: expect.anything() }));
  });

  it('observe: at the cap, logs and still starts the audit', async () => {
    process.env.AEO_GATE_MODE = 'observe';
    today.count = 3;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ url: 'https://example.com' }));
    expect(res.status).toBe(201);
    expect(log.mock.calls.flat().join(' ')).toContain('[gate] observe would-refuse DAILY_CAP');
  });
});
