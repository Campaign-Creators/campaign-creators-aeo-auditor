// A ChatGPT probe failure must be visible in the logs (status and code only, never the message
// or key), or a report says "unavailable" with no way to find out why.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async () => {
          const e = Object.assign(new Error('quota detail that must not be logged'), { status: 429, code: 'insufficient_quota' });
          throw e;
        },
      },
    };
  },
}));

import { probeOpenAI } from './ai-probe';

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { process.env.OPENAI_API_KEY = 'test-key'; spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { delete process.env.OPENAI_API_KEY; spy.mockRestore(); });

describe('ChatGPT probe failure logging', () => {
  it('logs status and code once per failed prompt, without the error message', async () => {
    const r = await probeOpenAI('https://test-site.example', 'Test Site', ['p1', 'p2']);
    expect(r.totalPrompts).toBe(0);
    expect(spy).toHaveBeenCalledTimes(2);
    const line = spy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(line).toContain('[ChatGPT probe]');
    expect(line).toContain('429');
    expect(line).toContain('insufficient_quota');
    expect(line).not.toContain('quota detail');
  });
});
