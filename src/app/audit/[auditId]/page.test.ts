// The report page decides on the server what report data reaches the browser.
/* eslint-disable @typescript-eslint/no-explicit-any -- the test inspects loosely shaped props */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { cookieValue, props } = vi.hoisted(() => ({
  cookieValue: { v: undefined as string | undefined },
  props: { last: null as null | Record<string, any> },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.v === undefined ? undefined : { value: cookieValue.v }),
  }),
}));

vi.mock('@/components/aeo/AuditResultPage', () => ({
  default: (p: Record<string, any>) => { props.last = p; return null; },
}));
vi.mock('@/components/aeo/AuditProgress', () => ({ default: () => null }));

const AUDIT = '22222222-2222-4222-8222-222222222222';
const fullResult = {
  id: 'r1', audit_request_id: AUDIT, overall_score: 61, overall_grade: 'C',
  answerability_score: 50, answerability_grade: 'C', brevity_score: 40, brevity_grade: 'D',
  trust_score: 30, trust_grade: 'F', structure_score: 20, structure_grade: 'F',
  freshness_score: 10, freshness_grade: 'F',
  raw_findings: {
    aiProbeStatus: 'ok',
    pages: [{ url: 'https://test-site.example/secret-page' }],
    robots: { gptBotDisallowed: true },
    customProbe: { prompts: ['private question'] },
    aiProbe: {
      prompts: ['what is the best agency'],
      claude: { engine: 'claude', status: 'partial', citedCount: 1, totalPrompts: 2,
        results: [
          { prompt: 'what is the best agency', cited: true, snippet: 'answer text', mentionedDomains: ['rival.example'] },
          { prompt: 'who to hire', cited: false, snippet: 'other text', mentionedDomains: [] },
        ] },
      openai: null, perplexity: null,
    },
  },
  created_at: '2026-11-01T00:00:00Z',
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'audit_requests'
              ? { data: { id: AUDIT, url: 'https://test-site.example', status: 'complete', created_at: '2026-11-01T00:00:00Z' } }
              : { data: structuredClone(fullResult) },
        }),
      }),
    }),
  }),
}));

async function renderProps(): Promise<Record<string, any>> {
  const { default: Page } = await import('./page');
  const el = await Page({ params: Promise.resolve({ auditId: AUDIT }) }) as any;
  // The page returns <AuditResultPage .../>; call it to capture the props it was given.
  el.type(el.props);
  return props.last!;
}

beforeEach(() => {
  vi.resetModules();
  cookieValue.v = undefined;
  props.last = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  process.env.AEO_UNLOCK_COOKIE_SECRET = 'test-secret';
});

afterEach(() => {
  for (const k of ['AEO_GATE_MODE', 'AEO_UNLOCK_COOKIE_SECRET']) delete process.env[k];
});

describe('report data sent to the browser', () => {
  it('enforce without an unlock sends only the preview fields', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    const p = await renderProps();
    const sent = JSON.stringify(p.auditData);
    expect(p.locked).toBe(true);
    for (const s of ['secret-page', 'gptBotDisallowed', 'private question', 'answer text', 'rival.example', 'what is the best agency']) {
      expect(sent).not.toContain(s);
    }
    expect(p.auditData.trust_score).toBe(0);
    expect(p.auditData.overall_score).toBe(61);
    expect(p.auditData.raw_findings.aiProbe.claude.citedCount).toBe(1);
    expect(p.auditData.raw_findings.aiProbe.claude.results).toHaveLength(2);
  });

  it('enforce with a valid unlock sends the full report', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    const { unlockToken } = await import('@/lib/gate');
    cookieValue.v = unlockToken(AUDIT)!;
    const p = await renderProps();
    expect(p.locked).toBe(false);
    expect(JSON.stringify(p.auditData)).toContain('secret-page');
  });

  it('enforce with no cookie secret configured fails closed', async () => {
    process.env.AEO_GATE_MODE = 'enforce';
    delete process.env.AEO_UNLOCK_COOKIE_SECRET;
    cookieValue.v = 'anything';
    const p = await renderProps();
    expect(p.locked).toBe(true);
  });

  it('observe sends the full report', async () => {
    process.env.AEO_GATE_MODE = 'observe';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = await renderProps();
    expect(p.locked).toBe(false);
    expect(JSON.stringify(p.auditData)).toContain('secret-page');
    expect(log.mock.calls.flat().join(' ')).toContain('[gate] observe would-refuse REPORT_LOCKED');
    log.mockRestore();
  });

  it('off (unset) sends the full report', async () => {
    const p = await renderProps();
    expect(p.locked).toBe(false);
    expect(JSON.stringify(p.auditData)).toContain('secret-page');
  });
});
