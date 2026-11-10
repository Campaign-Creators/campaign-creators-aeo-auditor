// A prompt the engine failed to answer is not a miss: it is left out, so an engine
// outage does not lower the citation rate (TDD open item 8).

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

const prompts = ['p1', 'p2', 'p3', 'p4'];

beforeEach(() => { answers.length = 0; process.env.OPENAI_API_KEY = 'test-key'; });
afterEach(() => { delete process.env.OPENAI_API_KEY; });

describe('engine errors', () => {
  it('failed prompts are left out of the totals', async () => {
    answers.push('Try test-site.example.', new Error('rate limited'), new Error('rate limited'), 'Try other.example.');
    const r = await probeOpenAI('https://test-site.example', 'Test Site', prompts);
    expect(r.totalPrompts).toBe(2);
    expect(r.citedCount).toBe(1);
  });

  it('an engine that failed every prompt counts as not run', async () => {
    answers.push(...prompts.map(() => new Error('down')));
    const r = await probeOpenAI('https://test-site.example', 'Test Site', prompts);
    expect(r.totalPrompts).toBe(0);
    expect(probeTotals({ openai: r, claude: { citedCount: 2, totalPrompts: 4 } })).toEqual({ citedCount: 2, totalPrompts: 4 });
  });
});
