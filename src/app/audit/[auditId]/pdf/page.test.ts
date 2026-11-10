// The print view must follow the same report access rule as the report page.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { cookieValue } = vi.hoisted(() => ({ cookieValue: { v: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.v === undefined ? undefined : { value: cookieValue.v }),
  }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'audit_requests'
              ? { data: { id: AUDIT, url: 'https://test-site.example', status: 'complete', created_at: '2026-11-01T00:00:00Z' } }
              : {
                  data: {
                    id: 'r1', audit_request_id: AUDIT, overall_score: 61, overall_grade: 'C',
                    answerability_score: 50, brevity_score: 40, trust_score: 30, structure_score: 20, freshness_score: 10,
                    raw_findings: { pages: [{ url: 'https://test-site.example/secret-page', statusCode: 200 }] },
                    created_at: '2026-11-01T00:00:00Z',
                  },
                },
        }),
      }),
    }),
  }),
}));

const AUDIT = '11111111-1111-4111-8111-111111111111';
const ENV_KEYS = ['AEO_GATE_MODE', 'AEO_UNLOCK_COOKIE_SECRET', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

async function render(): Promise<string> {
  const { default: Page } = await import('./page');
  const el = await Page({ params: Promise.resolve({ auditId: AUDIT }) });
  return renderToStaticMarkup(createElement(() => el));
}

beforeEach(() => {
  vi.resetModules();
  cookieValue.v = undefined;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  process.env.AEO_UNLOCK_COOKIE_SECRET = 'test-secret';
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('print report access', () => {
  it('enforce without an unlock returns no report detail', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    const html = await render();
    expect(html).not.toContain('secret-page');
    expect(html).not.toContain('robots.txt allows AI bots');
    expect(html).toContain(`/audit/${AUDIT}`);
  });

  it('enforce with a valid unlock returns the report', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    const { unlockToken } = await import('@/lib/gate');
    cookieValue.v = unlockToken(AUDIT)!;
    const html = await render();
    expect(html).toContain('robots.txt allows AI bots');
  });

  it('enforce with a forged cookie returns no report detail', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    cookieValue.v = 'forged';
    const html = await render();
    expect(html).not.toContain('robots.txt allows AI bots');
  });

  it('observe still returns the report and logs a would-refuse', async () => {
    process.env.AEO_GATE_MODE = 'observe';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const html = await render();
    expect(html).toContain('robots.txt allows AI bots');
    expect(log.mock.calls.flat().join(' ')).toContain('[gate] observe would-refuse REPORT_LOCKED');
    log.mockRestore();
  });

  it('off (unset) keeps today\'s behaviour', async () => {
    const html = await render();
    expect(html).toContain('robots.txt allows AI bots');
  });
});
