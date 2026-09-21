// Tests for the overall score, and specifically for what happens when the AI probe does not run.
//
// These exist because of a defect measured against the live database on 2026-09-17: when the
// probe returned nothing, the scorer dropped ai_citation — 40% of the grade — and averaged the
// remaining five dimensions equally. ai_citation is zero for a site nothing cites, so dropping it
// does not neutralise the dimension, it deletes a zero and the grade goes UP. Re-measured
// 2026-09-20 with probeTotals() itself as the test: 12 of 290 stored reports took that path,
// 8 of them carry a grade that would otherwise be F, and 2 of those 8 are showing a B
// (thechannelcompany.com 70 B -> 41 F, surfsoccer.com 73 B -> 42 F).
//
// An earlier note here said 23 / 14 / 3. That 23 came from inferring the path by matching each
// stored overall against the 5-dimension average within +/-1, which also catches 11 reports whose
// probe DID run and whose weighted score happens to land within a point of the average. The
// stored rows have not changed since 2026-09-14, so this is a definition difference, not drift.
//
// Before this file, src/lib/scoring.ts had no tests at all, and neither did the two route handlers
// that duplicated this arithmetic between them.

import { describe, it, expect } from 'vitest';
import {
  computeOverall,
  probeTotals,
  AI_CITATION_WEIGHT,
  CONTENT_DIMENSION_WEIGHT,
} from '@/lib/scoring';

/** Five dimensions all at the same value, which makes the arithmetic checkable by hand. */
const five = (n: number) => ({
  answerability_score: n,
  brevity_score: n,
  trust_score: n,
  structure_score: n,
  freshness_score: n,
});

describe('the weights', () => {
  it('sum to one', () => {
    expect(AI_CITATION_WEIGHT + CONTENT_DIMENSION_WEIGHT * 5).toBeCloseTo(1, 10);
  });
});

describe('computeOverall — the regression', () => {
  it('does not let a failed probe raise the grade', () => {
    const dims = five(70);

    const probeRan = computeOverall(dims, { citedCount: 0, totalPrompts: 6 });
    const probeFailed = computeOverall(dims, null);

    // The same site, the same content, two very different numbers.
    expect(probeRan.overall_score).toBe(42);
    expect(probeFailed.overall_score).toBe(70);

    // This gap is the whole point: a site cited nowhere reads F, an infrastructure failure reads B.
    expect(probeRan.overall_grade).toBe('F');
    expect(probeFailed.overall_grade).toBe('B');
    expect(probeFailed.overall_score).toBeGreaterThan(probeRan.overall_score);

    // Which is tolerable ONLY because the result now says which one happened.
    expect(probeRan.ai_probe_status).toBe('ok');
    expect(probeFailed.ai_probe_status).toBe('unavailable');
  });

  it('distinguishes "cited nowhere" from "never asked"', () => {
    // Zero is a finding. null is the absence of one. Collapsing them is how this shipped.
    expect(computeOverall(five(70), { citedCount: 0, totalPrompts: 6 }).ai_citation_score).toBe(0);
    expect(computeOverall(five(70), null).ai_citation_score).toBeNull();
  });

  it('scores a fully cited site on the weighted formula', () => {
    const r = computeOverall(five(80), { citedCount: 6, totalPrompts: 6 });
    expect(r.ai_citation_score).toBe(100);
    expect(r.overall_score).toBe(Math.round(100 * 0.4 + 400 * 0.12)); // 40 + 48 = 88
    expect(r.ai_cited_count).toBe(6);
    expect(r.ai_prompts_total).toBe(6);
  });

  it('keeps the score inside the range getGrade accepts', () => {
    // getGrade throws outside 0–100, which would take the whole audit down rather than misgrade it.
    for (const n of [0, 1, 49, 50, 99, 100]) {
      expect(() => computeOverall(five(n), null)).not.toThrow();
      expect(() => computeOverall(five(n), { citedCount: 0, totalPrompts: 4 })).not.toThrow();
      expect(() => computeOverall(five(n), { citedCount: 4, totalPrompts: 4 })).not.toThrow();
    }
  });
});

describe('probeTotals — the two shapes that drifted apart', () => {
  it('reads the single-result shape the crawl route produces', () => {
    expect(probeTotals({ results: [{}], citedCount: 2, totalPrompts: 6 }))
      .toEqual({ citedCount: 2, totalPrompts: 6 });
  });

  it('sums the four engines the Inngest pipeline produces', () => {
    const multi = {
      claude: { citedCount: 1, totalPrompts: 5 },
      openai: { citedCount: 2, totalPrompts: 5 },
      perplexity: { citedCount: 0, totalPrompts: 5 },
      google: { citedCount: 3, totalPrompts: 5 },
    };
    expect(probeTotals(multi)).toEqual({ citedCount: 6, totalPrompts: 20 });
  });

  it('ignores engines that returned nothing rather than counting them as zero-cited', () => {
    // An engine that errored has no denominator. Counting its prompts would read as
    // "we asked and were not cited", which is a different and wrong claim.
    const partial = {
      claude: { citedCount: 2, totalPrompts: 5 },
      openai: { citedCount: 0, totalPrompts: 0 },
      perplexity: null,
      google: undefined,
    };
    expect(probeTotals(partial)).toEqual({ citedCount: 2, totalPrompts: 5 });
  });

  it('treats no probe, an empty probe and a zero-prompt probe alike', () => {
    expect(probeTotals(null)).toBeNull();
    expect(probeTotals(undefined)).toBeNull();
    expect(probeTotals({})).toBeNull();
    expect(probeTotals({ citedCount: 0, totalPrompts: 0 })).toBeNull();
    expect(probeTotals({ claude: { citedCount: 0, totalPrompts: 0 } })).toBeNull();
  });

  it('never divides by zero', () => {
    // The guard that matters: probeTotals must not hand computeOverall a zero denominator.
    const t = probeTotals({ citedCount: 0, totalPrompts: 0 });
    expect(t).toBeNull();
    expect(computeOverall(five(60), t).ai_probe_status).toBe('unavailable');
  });
});
