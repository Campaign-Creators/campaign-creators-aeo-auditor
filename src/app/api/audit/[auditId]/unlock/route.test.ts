// The unlock endpoint is public and unauthenticated, and a call can write a lead row and
// a HubSpot contact. These cover the budget that sits in front of it, the deliberate
// decision to let a real capture through when the limiter itself is broken, and the
// checks on which audits and which details it accepts.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { rateLimitMock, syncMock, upsertMock, db } = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  syncMock: vi.fn(),
  upsertMock: vi.fn(),
  db: {
    request: {} as Record<string, unknown>,
    result: null as unknown,
    leads: [] as Array<Record<string, string>>,
    failLeadCount: false,
  },
}));

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: rateLimitMock,
  getClientIp: () => '203.0.113.7',
}));

vi.mock('@/lib/hubspot', () => ({
  syncAeoLead: syncMock,
}));

const { staffMock } = vi.hoisted(() => ({ staffMock: vi.fn(async (): Promise<string | null> => null) }));
vi.mock('@/lib/staff', () => ({ staffEmail: staffMock }));

/** A `leads` count query: `.eq()` filters chain, awaiting gives `{ count, error }`. */
function leadCount(filters: Array<[string, string]> = []): unknown {
  const run = () => db.failLeadCount
    ? { count: null, error: { message: 'down' } }
    : { count: db.leads.filter(l => filters.every(([c, v]) => l[c] === v)).length, error: null };
  return {
    eq: (c: string, v: string) => leadCount([...filters, [c, v]]),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => table === 'leads' ? leadCount() : ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'audit_requests'
              ? { data: { id: AUDIT, url: 'https://example.com', created_at: '2026-09-01T00:00:00Z', ...db.request } }
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

const AUDIT = '22222222-2222-4222-8222-222222222222';

function makeRequest(body: unknown, id = AUDIT) {
  return new Request(`http://localhost:3000/api/audit/${id}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

const ctxFor = (auditId: string) => ({ params: Promise.resolve({ auditId }) });
const ctx = ctxFor(AUDIT);
const validBody = { name: 'Ada Lovelace', email: 'ada@acme-widgets.com' };
const ready = () => { db.request = { status: 'complete' }; db.result = { overall_score: 50, raw_findings: null }; };

beforeEach(() => {
  vi.resetModules();
  rateLimitMock.mockReset();
  syncMock.mockReset();
  upsertMock.mockReset();
  staffMock.mockReset();
  staffMock.mockResolvedValue(null);
  db.request = {};
  db.result = null;
  db.leads = [];
  db.failLeadCount = false;
  ready();
  delete process.env.AEO_GATE_MODE;
  delete process.env.AEO_REPORT_GATE;
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
      expect.objectContaining({ email: 'ada@acme-widgets.com', name: 'Ada Lovelace' }),
      expect.anything(),
    );
    expect(syncMock).toHaveBeenCalledTimes(1);
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
  it('an audit that is not finished writes no lead (default, nothing set)', async () => {
    db.request = { status: 'pending' };
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(409);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('a failed audit writes no lead', async () => {
    db.request = { status: 'failed' };
    const { POST } = await import('./route');
    expect((await POST(makeRequest(validBody), ctx)).status).toBe(409);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('a finished audit without results writes no lead', async () => {
    db.result = null;
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(409);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('report gate observe: an unfinished audit is logged, and the lead is still written', async () => {
    process.env.AEO_REPORT_GATE = 'observe';
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
    process.env.AEO_UNLOCK_COOKIE_SECRET = 'test-value';
    const { POST } = await import('./route');
    const { unlockToken } = await import('@/lib/gate');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalled();
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`aeo_unlock_${AUDIT}=${unlockToken(AUDIT)}`);
    expect(cookie.toLowerCase()).toContain('httponly');
  });

  it('sets the proof cookie with no dedicated key configured', async () => {
    const { POST } = await import('./route');
    const { unlockToken } = await import('@/lib/gate');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain(`aeo_unlock_${AUDIT}=${unlockToken(AUDIT)}`);
  });

  it('staff unlock: no name or email needed, no lead, no HubSpot, but the cookie is set (AC-020)', async () => {
    staffMock.mockResolvedValueOnce('staff@example.com');
    const { POST } = await import('./route');
    const res = await POST(makeRequest({}), ctx);

    expect(res.status).toBe(200);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').toContain(`aeo_unlock_${AUDIT}=`);
  });

  it('a public caller with an empty body is still refused', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({}), ctx);
    expect(res.status).toBe(400);
  });
});

describe('unlock accepts only real ids and real details', () => {
  it('refuses an id that is not an audit id, before touching the database', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody, 'not-an-id'), ctxFor('not-an-id'));

    expect(res.status).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it.each(['someone@example.com', 'a@b.example.org', 'x@host.test', 'x@site.invalid', 'x@box.localhost'])(
    'refuses a reserved address (%s)', async (email) => {
      const { POST } = await import('./route');
      const res = await POST(makeRequest({ name: 'Test', email }), ctx);

      expect(res.status).toBe(400);
      expect(upsertMock).not.toHaveBeenCalled();
      expect(syncMock).not.toHaveBeenCalled();
    },
  );

  it('the same email on the same audit again: no new write, no CRM call, still unlocked', async () => {
    db.leads = [{ audit_request_id: AUDIT, email: 'ada@acme-widgets.com' }];
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ ...validBody, email: 'ADA@acme-widgets.com' }), ctx);

    expect(res.status).toBe(200);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').toContain(`aeo_unlock_${AUDIT}=`);
  });

  it('refuses a new email once an audit already has the most leads it accepts', async () => {
    db.leads = Array.from({ length: 5 }, (_, i) => ({ audit_request_id: AUDIT, email: `p${i}@acme-widgets.com` }));
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);

    expect(res.status).toBe(429);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('leads on other audits do not count toward that limit', async () => {
    db.leads = Array.from({ length: 5 }, (_, i) => ({ audit_request_id: 'other', email: `p${i}@acme-widgets.com` }));
    const { POST } = await import('./route');
    expect((await POST(makeRequest(validBody), ctx)).status).toBe(200);
    expect(upsertMock).toHaveBeenCalled();
  });

  it('fails open when the lead check cannot run: the capture still happens', async () => {
    db.failLeadCount = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody), ctx);
    err.mockRestore();

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalled();
  });
});
