// FR-017 / AC-023: a short guide on the report, shown once on the first visit, replayed
// from a Tutorials button. Ships dark behind NEXT_PUBLIC_AEO_GUIDE=on.

import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReportGuide, { GUIDE_STEPS, GUIDE_SEEN_KEY, guideEnabled, shouldAutoOpen } from './ReportGuide';

afterEach(() => { delete process.env.NEXT_PUBLIC_AEO_GUIDE; });

describe('report guide', () => {
  it('is off unless the flag is on', () => {
    expect(guideEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_AEO_GUIDE = 'yes';
    expect(guideEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_AEO_GUIDE = 'on';
    expect(guideEnabled()).toBe(true);
  });

  it('opens by itself only on the first visit', () => {
    expect(shouldAutoOpen(true, null)).toBe(true);
    expect(shouldAutoOpen(true, '1')).toBe(false);
    expect(shouldAutoOpen(false, null)).toBe(false);
  });

  it('renders nothing when off, and a Tutorials button when on', () => {
    expect(renderToStaticMarkup(createElement(ReportGuide))).toBe('');
    process.env.NEXT_PUBLIC_AEO_GUIDE = 'on';
    expect(renderToStaticMarkup(createElement(ReportGuide))).toContain('Tutorials');
  });

  it('has three short steps with a title and text each', () => {
    expect(GUIDE_STEPS).toHaveLength(3);
    for (const s of GUIDE_STEPS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.text.length).toBeLessThan(200);
    }
    expect(GUIDE_SEEN_KEY).toMatch(/^aeo-/);
  });
});
