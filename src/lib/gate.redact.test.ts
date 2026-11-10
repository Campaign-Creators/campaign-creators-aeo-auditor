// The locked preview keeps what the badges need: an engine that failed every prompt must
// still read UNAVAILABLE, not COMING SOON.

import { describe, it, expect } from 'vitest';
import { redactForPreview } from './gate';
import { engineBadge } from './auditor/engineBadge';

describe('redactForPreview and engine badges', () => {
  it('keeps the failed-prompt count, and nothing of the answers', () => {
    const out = redactForPreview({
      id: 'r1', overall_score: 50, overall_grade: 'D', created_at: 'x',
      raw_findings: {
        aiProbe: {
          prompts: ['secret question'],
          claude: { engine: 'Claude', status: 'missing', citedCount: 0, totalPrompts: 0, results: [], failedPrompts: 10 },
          openai: { engine: 'ChatGPT', status: 'partial', citedCount: 1, totalPrompts: 2,
            results: [{ prompt: 'secret question', cited: true, snippet: 'secret answer' }, { prompt: 'q2', cited: false }] },
          perplexity: null,
        },
      },
    });
    type Badge = { results: unknown[]; status: string; failedPrompts?: number } | null;
    const probe = (out.raw_findings as unknown as { aiProbe: Record<string, Badge> }).aiProbe;
    expect(engineBadge(probe.claude, 'COMING SOON')).toBe('UNAVAILABLE');
    expect(engineBadge(probe.openai, 'COMING SOON')).toBe('PARTIAL');
    expect(JSON.stringify(out)).not.toContain('secret');
  });
});
