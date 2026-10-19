import { describe, it, expect, beforeEach, vi } from 'vitest';

/* Custom prompts spend money: every run calls four paid AI engines. These specs pin the
   server-side checks that sit in front of that spend. The engines are mocked; the
   database is an in-memory fake, and the real rate limiter runs against it. */

const { db, probes } = vi.hoisted(() => ({
  db: {
    audits: new Map<string, { id: string; status: string; url: string }>(),
    results: new Map<string, { raw_findings: Record<string, unknown> }>(),
    leads: [] as Array<{ audit_request_id: string }>,
    rateLimits: [] as Array<{ ip: string; created_at: string }>,
    persistResults: true,
    failRateLimit: false,
    /** Fail only the limiter calls for this key. */
    failRateLimitKey: null as string | null,
    failLeads: false,
  },
  probes: {
    probeWithPrompts: vi.fn(),
    probeOpenAI: vi.fn(),
    probePerplexity: vi.fn(),
    probeGoogleAI: vi.fn(),
  },
}));

vi.mock('@/lib/auditor/ai-probe', () => probes);

type Filter = { col: string; op: 'eq' | 'gte'; val: unknown };

function query(table: string) {
  const filters: Filter[] = [];
  let op: 'select' | 'update' | 'insert' = 'select';
  let payload: Record<string, unknown> | null = null;
  let head = false;

  const rows = (): Array<Record<string, unknown>> => {
    const all: Array<Record<string, unknown>> =
      table === 'audit_requests'
        ? [...db.audits.values()]
        : table === 'audit_results'
          ? [...db.results.entries()].map(([id, r]) => ({ audit_request_id: id, ...r }))
          : table === 'leads'
            ? db.leads
            : db.rateLimits;
    return all.filter((r) =>
      filters.every((f) =>
        f.op === 'eq' ? r[f.col] === f.val : String(r[f.col]) >= String(f.val),
      ),
    );
  };

  const run = async () => {
    const forKey = (k: string) =>
      payload?.ip === k || filters.some((f) => f.col === 'ip' && f.val === k);
    const keyFails = db.failRateLimitKey !== null && forKey(db.failRateLimitKey);
    if (table === 'audit_rate_limits' && (db.failRateLimit || keyFails)) {
      return { data: null, count: null, error: { message: 'db down' } };
    }
    if (table === 'leads' && db.failLeads) {
      return { data: null, count: null, error: { message: 'db down' } };
    }
    if (op === 'insert') {
      if (table === 'audit_rate_limits') db.rateLimits.push(payload as never);
      return { data: null, error: null };
    }
    if (op === 'update') {
      if (table === 'audit_results' && db.persistResults) {
        const id = filters.find((f) => f.col === 'audit_request_id')!.val as string;
        db.results.set(id, { raw_findings: payload!.raw_findings as Record<string, unknown> });
      }
      return { data: null, error: null };
    }
    const found = rows();
    return { data: head ? null : found, count: found.length, error: null };
  };

  const builder = {
    select: (_cols?: string, opts?: { head?: boolean }) => {
      head = Boolean(opts?.head);
      return builder;
    },
    insert: (p: Record<string, unknown>) => {
      op = 'insert';
      payload = p;
      return builder;
    },
    update: (p: Record<string, unknown>) => {
      op = 'update';
      payload = p;
      return builder;
    },
    eq: (col: string, val: unknown) => {
      filters.push({ col, op: 'eq', val });
      return builder;
    },
    gte: (col: string, val: unknown) => {
      filters.push({ col, op: 'gte', val });
      return builder;
    },
    limit: () => builder,
    maybeSingle: async () => {
      const r = await run();
      return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error };
    },
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      run().then(resolve, reject),
  };
  return builder;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (table: string) => query(table) }),
}));

const AUDIT_ID = '11111111-1111-4111-8111-111111111111';

function addAudit(id: string, { unlocked = true } = {}) {
  db.audits.set(id, { id, status: 'complete', url: 'https://example.com' });
  db.results.set(id, { raw_findings: {} });
  if (unlocked) db.leads.push({ audit_request_id: id });
}

function auditId(n: number): string {
  return `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
}

async function call(id: string, ip = '203.0.113.7', prompts: unknown = ['best crm']) {
  const { POST } = await import('./route');
  const req = new Request(`http://localhost:3000/api/audit/${id}/custom-prompts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ prompts }),
  }) as unknown as import('next/server').NextRequest;
  return POST(req, { params: Promise.resolve({ auditId: id }) });
}

function engineCalls(): number {
  return Object.values(probes).reduce((n, fn) => n + fn.mock.calls.length, 0);
}

beforeEach(() => {
  vi.resetModules();
  db.audits.clear();
  db.results.clear();
  db.leads.length = 0;
  db.rateLimits.length = 0;
  db.persistResults = true;
  db.failRateLimit = false;
  db.failRateLimitKey = null;
  db.failLeads = false;
  for (const fn of Object.values(probes)) {
    fn.mockReset();
    fn.mockResolvedValue({ citedCount: 0, totalPrompts: 1 });
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  delete process.env.CUSTOM_PROMPTS_GLOBAL_MAX;
});

describe('POST /api/audit/[auditId]/custom-prompts', () => {
  it('runs the engines once for an unlocked, complete audit', async () => {
    addAudit(AUDIT_ID);
    const res = await call(AUDIT_ID);
    expect(res.status).toBe(200);
    expect(engineCalls()).toBe(4);
  });

  it('refuses an audit that has not been unlocked, without calling any engine', async () => {
    addAudit(AUDIT_ID, { unlocked: false });
    const res = await call(AUDIT_ID);
    expect(res.status).toBe(403);
    expect(engineCalls()).toBe(0);
  });

  it('refuses the next run on the same audit within the window (429)', async () => {
    addAudit(AUDIT_ID);
    // Simulates a second request racing the first, before its results are stored.
    db.persistResults = false;

    expect((await call(AUDIT_ID, '203.0.113.7')).status).toBe(200);
    const second = await call(AUDIT_ID, '198.51.100.9');

    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
    expect(engineCalls()).toBe(4);
  });

  it('pays for at most one run when requests for one audit arrive together', async () => {
    addAudit(AUDIT_ID);
    db.persistResults = false;

    const statuses = (
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => call(AUDIT_ID, `198.51.100.${i + 1}`)),
      )
    ).map((r) => r.status);

    expect(engineCalls()).toBeLessThanOrEqual(4);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
  });

  it('answers 503, not "unlock first", when the unlock lookup fails', async () => {
    addAudit(AUDIT_ID);
    db.failLeads = true;
    const res = await call(AUDIT_ID);
    expect(res.status).toBe(503);
    expect(engineCalls()).toBe(0);
  });

  it('refuses request N+1 from the same IP across different audits (429)', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => auditId(i + 1));
    ids.forEach((id) => addAudit(id));

    const statuses: number[] = [];
    for (const id of ids) statuses.push((await call(id)).status);

    const allowed = statuses.indexOf(429);
    expect(allowed).toBeGreaterThan(0);
    expect(statuses.slice(0, allowed).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(allowed).every((s) => s === 429)).toBe(true);
    expect(engineCalls()).toBe(allowed * 4);

    // A different visitor still has their own budget.
    addAudit(auditId(99));
    expect((await call(auditId(99), '198.51.100.9')).status).toBe(200);
  });

  it('returns stored results without spending again or touching the budget', async () => {
    addAudit(AUDIT_ID);
    expect((await call(AUDIT_ID)).status).toBe(200);
    const budgetUsed = db.rateLimits.length;

    const again = await call(AUDIT_ID);
    expect(again.status).toBe(200);
    expect(engineCalls()).toBe(4);
    expect(db.rateLimits.length).toBe(budgetUsed);
  });

  it('caps runs across all visitors together, at the configured hourly maximum', async () => {
    process.env.CUSTOM_PROMPTS_GLOBAL_MAX = '2';
    const ids = [1, 2, 3].map((n) => auditId(n));
    ids.forEach((id) => addAudit(id));

    const statuses: number[] = [];
    for (const [i, id] of ids.entries()) statuses.push((await call(id, `198.51.100.${i + 1}`)).status);

    expect(statuses).toEqual([200, 200, 429]);
    expect(engineCalls()).toBe(8);
  });

  it('uses a safe default global cap when none is configured', async () => {
    const ids = Array.from({ length: 31 }, (_, i) => auditId(i + 1));
    ids.forEach((id) => addAudit(id));

    const statuses: number[] = [];
    for (const [i, id] of ids.entries()) statuses.push((await call(id, `198.51.100.${i + 1}`)).status);

    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it.each(['0', '-5', 'abc', '', '1abc', '1e3', '1.5'])(
    'falls back to the default for an unusable global cap setting (%j)',
    async (value) => {
      process.env.CUSTOM_PROMPTS_GLOBAL_MAX = value;
      const ids = [1, 2].map((n) => auditId(n));
      ids.forEach((id) => addAudit(id));
      // A misread cap of 1 (or 0) would refuse the second visitor.
      const statuses: number[] = [];
      for (const [i, id] of ids.entries()) statuses.push((await call(id, `198.51.100.${i + 1}`)).status);
      expect(statuses).toEqual([200, 200]);
    },
  );

  it('fails closed when only the all-visitors limiter cannot be checked', async () => {
    addAudit(AUDIT_ID);
    db.failRateLimitKey = 'custom-global';
    const res = await call(AUDIT_ID);
    expect(res.status).toBe(503);
    expect(engineCalls()).toBe(0);
  });

  it('fails closed when the limiter cannot be checked', async () => {
    addAudit(AUDIT_ID);
    db.failRateLimit = true;
    const res = await call(AUDIT_ID);
    expect(res.status).toBe(503);
    expect(engineCalls()).toBe(0);
  });
});
