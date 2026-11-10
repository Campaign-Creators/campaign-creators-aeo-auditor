// AC-003: an audit still "in progress" after 30 minutes is reported failed.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const AUDIT = '44444444-4444-4444-8444-444444444444';
const { row } = vi.hoisted(() => ({ row: { status: 'pending', created_at: '' } }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: AUDIT, url: 'https://test-site.example', ...row }, error: null }),
        }),
      }),
    }),
  }),
}));

async function status(): Promise<{ status: string; error?: string }> {
  const { GET } = await import('./route');
  const { NextRequest } = await import('next/server');
  const res = await GET(new NextRequest(`http://localhost:3000/api/audit/${AUDIT}/status`), {
    params: Promise.resolve({ auditId: AUDIT }),
  });
  return res.json();
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
});

describe('stale audits', () => {
  it.each(['pending', 'processing'])('%s for 31 minutes reads as failed', async (s) => {
    Object.assign(row, { status: s, created_at: minutesAgo(31) });
    const body = await status();
    expect(body.status).toBe('failed');
    expect(body.error).toBeTruthy();
  });

  it.each(['pending', 'processing'])('%s for 29 minutes is still in progress', async (s) => {
    Object.assign(row, { status: s, created_at: minutesAgo(29) });
    expect((await status()).status).toBe(s);
  });

  it('a stored failure reads as failed with a message', async () => {
    Object.assign(row, { status: 'failed', created_at: minutesAgo(1) });
    const body = await status();
    expect(body.status).toBe('failed');
    expect(body.error).toBeTruthy();
  });

  it('rejects an id that is not a uuid', async () => {
    const { GET } = await import('./route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://localhost:3000/api/audit/x/status'), {
      params: Promise.resolve({ auditId: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
  });
});
