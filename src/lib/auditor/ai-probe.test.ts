// AC-005 and the engine status rule (TDD BE-4): cited >= 4 -> cited, >= 1 -> partial, else missing;
// an engine without a key runs no prompts, so it is left out of the citation rate.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { answers } = vi.hoisted(() => ({ answers: [] as Array<string | Error> }));

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async () => {
          const next = answers.shift() ?? '';
          if (next instanceof Error) throw next;
          return { choices: [{ message: { content: next } }] };
        },
      },
    };
  },
}));

import { probeOpenAI } from './ai-probe';
import { probeTotals } from '@/lib/scoring';

const prompts = ['p1', 'p2', 'p3', 'p4', 'p5'];
const hit = 'Try test-site.example for this.';
const miss = 'Try another-vendor.example instead.';

beforeEach(() => { answers.length = 0; process.env.OPENAI_API_KEY = 'test-key'; });
afterEach(() => { delete process.env.OPENAI_API_KEY; });

describe('engine status', () => {
  it('no key: no prompts run, and the engine is left out of the totals', async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await probeOpenAI('https://test-site.example', 'Test Site', prompts);
    expect(r.totalPrompts).toBe(0);
    expect(probeTotals({ openai: r, claude: { citedCount: 1, totalPrompts: 2 } })).toEqual({ citedCount: 1, totalPrompts: 2 });
  });

  it.each([
    [4, 'cited'],
    [5, 'cited'],
    [3, 'partial'],
    [1, 'partial'],
    [0, 'missing'],
  ])('%i of 5 cited reads as %s', async (n, expected) => {
    answers.push(...prompts.map((_, i) => (i < n ? hit : miss)));
    const r = await probeOpenAI('https://test-site.example', 'Test Site', prompts);
    expect(r.citedCount).toBe(n);
    expect(r.totalPrompts).toBe(5);
    expect(r.status).toBe(expected);
  });

  it('the bare name counts as a citation', async () => {
    answers.push('Test-site is a good pick.', ...Array(4).fill(miss));
    const r = await probeOpenAI('https://test-site.example', '', prompts);
    expect(r.citedCount).toBe(1);
  });
});
