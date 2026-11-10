// The unlock endpoint is public and unauthenticated, and every call writes a lead row and
// a HubSpot contact. These cover the budget that now sits in front of it — and the
// deliberate decision to let a real capture through when the limiter itself is broken.
//
// See docs/audit/03-hubspot.md H1.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { rateLimitMock, syncMock, upsertMock, db } = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  syncMock: vi.fn(),
  upsertMock: vi.fn(),
  db: { request: {} as Record<string, unknown>, result: null as unknown },
}));

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: rateLimitMock,
  getClientIp: () => '203.0.113.7',
}));

vi.mock('@/lib/hubspot', () => ({
  syncAeoLead: syncMock,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'audit_requests'
              ? { data: { id: 'audit-1', url: 'https://example.com', created_at: '2026-09-01T00:00:00Z', ...db.request } }
              : { data: db.result },
        }),
      }),
      upsert: (...args: unknown[]) => {
        upsertMock(...args);
        return Promise.resolve({ error: null });
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

function makeRequest(body: unknown) {
  return new Request('http://localhost:3000/api/audit/audit-1/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

const ctx = { params: Promise.resolve({ auditId: 'audit-1' }) };
const validBody = { name: 'Ada Lovelace', email: 'ada@example.com' };

beforeEach(() => {
  vi.resetModules();
  rateLimitMock.mockReset();
  syncMock.mockReset();
  upsertMock.mockReset();
  db.request = {};
  db.result = null;
  delete process.env.AEO_GATE_MODE;
  delete process.env.AEO_UNLOCK_COOKIE_SECRET;
  rateLimitMock.mockResolvedValue({ limited: false });
  syncMock.mockResolvedValue({ id: 'contact-1' });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
});

describe('POST /api/audit/[auditId]/unlock', () => {
  it('uses a budget of its own, not the one that governs starting an audit', async () => {
    const { POST } = await import('./route');
    await POST(makeRequest(validBody), ctx);

    expect(rateLimitMock).toHaveBeenCalledWith('unlock:203.0.113.7', expect.any(Number));
  });

  it('returns 429 with Retry-After once the budget is spent, writing nothing', async () => {
    rateLimitMock.mockResolvedValue({ limited: true });
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(upsertMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('captures the lead normally when the budget allows it', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ada@example.com', name: 'Ada Lovelace' }),
      expect.anything(),
    );
  });

  it('fails open: a broken limiter must not cost a real lead', async () => {
    rateLimitMock.mockRejectedValue(new Error('database unavailable'));
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalled();
  });

  it('still rejects a malformed body after passing the limiter', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ name: '', email: 'not-an-email' }), ctx);

    expect(res.status).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe('unlock checks the audit and proves the unlock', () => {
  const ready = () => { db.request = { status: 'complete' }; db.result = { overall_score: 50, raw_findings: null }; };

  it('enforce: an audit that is not finished writes no lead', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    db.request = { status: 'pending' };
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(409);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('enforce: a finished audit without results writes no lead', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    db.request = { status: 'complete' };
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(409);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('observe: an unfinished audit is logged, and the lead is still written', async () => {
    process.env.AEO_GATE_MODE = 'observe';
    db.request = { status: 'failed' };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toContain('[gate] observe would-refuse UNLOCK_NOT_READY');
    log.mockRestore();
  });

  it('a finished audit unlocks and sets an httpOnly proof cookie for that audit', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    process.env.AEO_UNLOCK_COOKIE_SECRET = 'test-value';
    ready();
    const { POST } = await import('./route');
    const { unlockToken } = await import('@/lib/gate');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalled();
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`aeo_unlock_audit-1=${unlockToken('audit-1')}`);
    expect(cookie.toLowerCase()).toContain('httponly');
  });

  it('sets no cookie when none is configured', async () => {
    ready();
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
