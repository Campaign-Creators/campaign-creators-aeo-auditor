// The status endpoint follows the same report access rule as the report page.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const AUDIT = '33333333-3333-4333-8333-333333333333';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'audit_requests'
              ? { data: { id: AUDIT, status: 'complete', url: 'https://test-site.example', created_at: new Date().toISOString() }, error: null }
              : {
                  data: {
                    answerability_score: 51, answerability_grade: 'C', structure_score: 52, structure_grade: 'C',
                    trust_score: 53, trust_grade: 'C', freshness_score: 54, freshness_grade: 'C',
                    brevity_score: 55, brevity_grade: 'C', overall_score: 61, overall_grade: 'B',
                    raw_findings: null,
                  },
                  error: null,
                },
        }),
      }),
    }),
  }),
}));

async function get(cookie?: string) {
  const { GET } = await import('./route');
  const { NextRequest } = await import('next/server');
  const req = new NextRequest(`http://localhost:3000/api/audit/${AUDIT}/status`, {
    headers: cookie ? { cookie } : {},
  });
  const res = await GET(req, { params: Promise.resolve({ auditId: AUDIT }) });
  return res.json();
}

beforeEach(() => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  process.env.AEO_UNLOCK_COOKIE_SECRET = 'test-value';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { delete process.env.AEO_GATE_MODE; delete process.env.AEO_UNLOCK_COOKIE_SECRET; });

describe('GET /api/audit/[auditId]/status', () => {
  it('enforce without an unlock returns only the overall score', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    const body = await get();
    expect(body.status).toBe('complete');
    expect(body.categories).toEqual({ overall: { score: 61, grade: 'B' } });
  });

  it('enforce with the unlock cookie returns every category', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    const { unlockToken, unlockCookieName } = await import('@/lib/gate');
    const body = await get(`${unlockCookieName(AUDIT)}=${unlockToken(AUDIT)}`);
    expect(body.categories.trust).toEqual({ score: 53, grade: 'C' });
  });

  it('off returns every category, as today', async () => {
    const body = await get();
    expect(body.categories.trust).toEqual({ score: 53, grade: 'C' });
  });
});
