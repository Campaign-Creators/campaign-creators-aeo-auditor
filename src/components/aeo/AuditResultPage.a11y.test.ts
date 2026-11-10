// NFR-003: every input on the report has an accessible name and the right autocomplete.

import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import AuditResultPage from './AuditResultPage';

const html = renderToStaticMarkup(
  createElement(AuditResultPage, {
    requestData: { id: 'a1', url: 'https://test-site.example', status: 'complete', created_at: '2026-11-01T00:00:00Z' },
    auditData: {
      id: 'r1', overall_score: 61, overall_grade: 'C',
      answerability_score: 50, answerability_grade: 'C', brevity_score: 40, brevity_grade: 'D',
      trust_score: 30, trust_grade: 'F', structure_score: 20, structure_grade: 'F',
      freshness_score: 10, freshness_grade: 'F', raw_findings: {}, created_at: '2026-11-01T00:00:00Z',
    },
  }),
);

const inputs = html.match(/<input[^>]*>/g) ?? [];

describe('report inputs', () => {
  it('there are inputs to check', () => {
    expect(inputs.length).toBeGreaterThanOrEqual(5);
  });

  it('every input has an accessible name', () => {
    for (const i of inputs) expect(i).toMatch(/aria-label="[^"]+"|id="[^"]+"/);
  });

  it('the unlock form asks the browser for name and email', () => {
    expect(html).toMatch(/<input[^>]*autoComplete="name"|<input[^>]*autocomplete="name"/i);
    expect(html).toMatch(/<input[^>]*autocomplete="email"/i);
  });
});
