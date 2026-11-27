// Google AI probe: Google search results often carry the AI Overview only as a page_token
// that has to be fetched from the google_ai_overview engine, and sources are listed under
// `references`. Both must count, or every domain reads as never cited.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeGoogleAI } from './ai-probe';

type Json = Record<string, unknown>;
let routes: Array<(url: URL) => Json | null>;
const calls: URL[] = [];

beforeEach(() => {
  process.env.SERPAPI_API_KEY = 'test-key';
  routes = [];
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    for (const r of routes) {
      const body = r(url);
      if (body) return { ok: true, json: async () => body } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }));
});
afterEach(() => {
  delete process.env.SERPAPI_API_KEY;
  vi.unstubAllGlobals();
});

const search = (body: Json) => (u: URL) => (u.searchParams.get('engine') === 'google' ? body : null);
const overview = (body: Json) => (u: URL) => (u.searchParams.get('engine') === 'google_ai_overview' ? body : null);

describe('Google AI probe', () => {
  it('follows the page_token to the AI Overview engine and reads its text blocks', async () => {
    routes.push(search({ ai_overview: { page_token: 'tok-1' } }));
    routes.push(overview({
      ai_overview: {
        text_blocks: [
          { type: 'paragraph', snippet: 'Clean-label options include cultured ingredients.' },
          { type: 'list', list: [{ title: 'Suppliers', snippet: 'Test Site offers fermentation-based solutions.' }] },
        ],
      },
    }));
    const r = await probeGoogleAI('https://test-site.example', 'Test Site', ['q1']);
    const tokenCall = calls.find(u => u.searchParams.get('engine') === 'google_ai_overview');
    expect(tokenCall?.searchParams.get('page_token')).toBe('tok-1');
    expect(r.totalPrompts).toBe(1);
    expect(r.citedCount).toBe(1);
    expect(r.results[0].response).toContain('fermentation-based');
  });

  it('counts a citation listed only in ai_overview.references', async () => {
    routes.push(search({
      ai_overview: {
        text_blocks: [{ type: 'paragraph', snippet: 'Several suppliers make natural preservatives.' }],
        references: [{ title: 'Natural preservation', link: 'https://www.test-site.example/bakery', index: 0 }],
      },
    }));
    const r = await probeGoogleAI('https://test-site.example', 'Test Site', ['q1']);
    expect(r.citedCount).toBe(1);
  });

  it('a query with no AI Overview and no organic hit is answered but not cited', async () => {
    routes.push(search({ organic_results: [{ link: 'https://other.example', title: 'Other' }] }));
    const r = await probeGoogleAI('https://test-site.example', 'Test Site', ['q1']);
    expect(r.totalPrompts).toBe(1);
    expect(r.citedCount).toBe(0);
  });
});
