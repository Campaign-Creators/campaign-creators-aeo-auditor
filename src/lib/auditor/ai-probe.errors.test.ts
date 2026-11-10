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

const { claudeAnswers } = vi.hoisted(() => ({ claudeAnswers: [] as Array<string | Error> }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async () => {
        const next = claudeAnswers.shift() ?? '';
        if (next instanceof Error) throw next;
        return { content: [{ type: 'text', text: next }] };
      },
    };
  },
}));

import { probeOpenAI, probeWithPrompts } from './ai-probe';
import { engineBadge } from './engineBadge';
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
    expect(r.failedPrompts).toBe(4);
    expect(engineBadge(r, 'COMING SOON')).toBe('UNAVAILABLE');
  });

  it('records how many prompts failed, and nothing when none did', async () => {
    answers.push('a', new Error('x'), 'b', 'c');
    expect((await probeOpenAI('https://test-site.example', '', prompts)).failedPrompts).toBe(1);
    answers.push('a', 'b', 'c', 'd');
    expect((await probeOpenAI('https://test-site.example', '', prompts)).failedPrompts).toBeUndefined();
  });

  it('Claude: failed prompts are left out too', async () => {
    claudeAnswers.push('Try test-site.example.', new Error('overloaded'), 'Nothing here.', new Error('overloaded'));
    const r = await probeWithPrompts('https://test-site.example', 'Test Site', prompts);
    expect(r.totalPrompts).toBe(2);
    expect(r.citedCount).toBe(1);
    expect(r.failedPrompts).toBe(2);
  });
});

describe('engine badge', () => {
  it('no probe or no key reads as the empty label; results read as their status', () => {
    expect(engineBadge(null, 'PENDING')).toBe('PENDING');
    expect(engineBadge({ results: [], status: 'missing' }, 'COMING SOON')).toBe('COMING SOON');
    expect(engineBadge({ results: [{}], status: 'partial' }, 'COMING SOON')).toBe('PARTIAL');
  });
});
