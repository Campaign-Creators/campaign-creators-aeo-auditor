// Tests for the two scoring inputs that used to be hardcoded.
//
// Measured against the live database on 2026-09-20: `freshness_score` was 0 in 290 of 290
// stored audits, and `answerability_score` never exceeded 70 across the same 290 — both
// because deriveFindingsFromCrawl passed `lastModified: null` and `sitemapListed: false`
// regardless of what the crawler found. The scorers themselves were fine; they were being
// starved of input. See docs/audit/01-crawler.md (F1, F2) and docs/audit/02-grading.md (G7).
//
// The file is named scoring.inputs.test.ts rather than scoring.test.ts to avoid colliding
// with the tests on branch fix/ai-probe-caveat, which covers the overall-score arithmetic.

import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  runScorers,
  scoreAiCrawler,
  scoreFreshness,
  sitemapListsAuditedDomain,
} from '@/lib/scoring';
import { pickLastModified, newerDate } from '@/lib/auditor/lastModified';
import type { CrawlPage, CrawlRobotsData } from '@/types/audit';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const openRobots: CrawlRobotsData = {
  raw: '',
  gptBotDisallowed: false,
  claudeBotDisallowed: false,
  googlebotDisallowed: false,
  bingbotDisallowed: false,
  fullDisallowAll: false,
};

function page(overrides: Partial<CrawlPage> = {}): CrawlPage {
  return {
    url: 'https://example.com',
    statusCode: 200,
    title: 'Example',
    metaDescription: 'An example',
    h1: 'Example',
    h2s: [],
    bodyText: 'word '.repeat(700),
    wordCount: 700,
    internalLinks: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
    externalLinks: ['https://other.com'],
    hasStructuredData: false,
    structuredDataTypes: [],
    canonicalUrl: 'https://example.com',
    robotsMeta: null,
    openGraphTags: { 'og:title': 'Example' },
    lastModified: null,
    fetchError: null,
    ...overrides,
  };
}

describe('pickLastModified', () => {
  it('prefers the Last-Modified header', () => {
    const $ = cheerio.load('<meta property="article:modified_time" content="2020-01-01">');
    const iso = pickLastModified('Wed, 10 Sep 2026 10:00:00 GMT', $);
    expect(iso).not.toBeNull();
    expect(new Date(iso as string).getUTCFullYear()).toBe(2026);
  });

  it('falls back to article:modified_time, then JSON-LD, then <time>', () => {
    const meta = cheerio.load('<meta property="article:modified_time" content="2026-09-01T00:00:00Z">');
    expect(pickLastModified(null, meta)).toBe('2026-09-01T00:00:00.000Z');

    const ld = cheerio.load(
      '<script type="application/ld+json">{"@type":"Article","dateModified":"2026-08-15T00:00:00Z"}</script>',
    );
    expect(pickLastModified(null, ld)).toBe('2026-08-15T00:00:00.000Z');

    const time = cheerio.load('<time datetime="2026-07-04T00:00:00Z">July</time>');
    expect(pickLastModified(null, time)).toBe('2026-07-04T00:00:00.000Z');
  });

  it('takes the newest date in nested JSON-LD, not the first one seen', () => {
    const $ = cheerio.load(
      '<script type="application/ld+json">' +
        '{"@graph":[{"datePublished":"2024-01-01T00:00:00Z"},{"dateModified":"2026-06-01T00:00:00Z"}]}' +
        '</script>',
    );
    expect(pickLastModified(null, $)).toBe('2026-06-01T00:00:00.000Z');
  });

  it('rejects unparseable, prehistoric and far-future dates rather than scoring them', () => {
    const empty = cheerio.load('<html></html>');
    expect(pickLastModified('not a date', empty)).toBeNull();
    expect(pickLastModified('1998-01-01T00:00:00Z', empty)).toBeNull();
    expect(pickLastModified(new Date(Date.now() + 90 * 86_400_000).toISOString(), empty)).toBeNull();
  });

  it('returns null when the page publishes no date at all', () => {
    expect(pickLastModified(null, cheerio.load('<html><body>hi</body></html>'))).toBeNull();
  });

  it('newerDate keeps the later of two dates and tolerates nulls', () => {
    expect(newerDate('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z')).toBe('2026-06-01T00:00:00Z');
    expect(newerDate(null, '2026-06-01T00:00:00Z')).toBe('2026-06-01T00:00:00Z');
    expect(newerDate('2026-06-01T00:00:00Z', null)).toBe('2026-06-01T00:00:00Z');
    expect(newerDate(null, null)).toBeNull();
  });
});

describe('sitemapListsAuditedDomain', () => {
  it('matches the audited host, ignoring www', () => {
    expect(sitemapListsAuditedDomain(['https://www.example.com/pricing'], 'https://example.com')).toBe(true);
    expect(sitemapListsAuditedDomain(['https://example.com/a'], 'https://www.example.com')).toBe(true);
  });

  it('does not count someone else\'s sitemap entries, or junk', () => {
    expect(sitemapListsAuditedDomain(['https://other.com/a'], 'https://example.com')).toBe(false);
    expect(sitemapListsAuditedDomain(['not a url'], 'https://example.com')).toBe(false);
    expect(sitemapListsAuditedDomain([], 'https://example.com')).toBe(false);
  });
});

describe('the two dimensions these inputs feed', () => {
  it('freshness is no longer pinned at zero when a page publishes a date', () => {
    const fresh = runScorers({
      crawledPages: [page({ lastModified: daysAgo(10) })],
      robotsData: openRobots,
      domainUrl: 'https://example.com',
    });
    expect(fresh.freshness_score).toBe(100);

    const stale = runScorers({
      crawledPages: [page({ lastModified: daysAgo(400) })],
      robotsData: openRobots,
      domainUrl: 'https://example.com',
    });
    expect(stale.freshness_score).toBe(10);
  });

  it('a site that publishes no date still scores 0 — that answer was always correct', () => {
    const none = runScorers({
      crawledPages: [page({ lastModified: null })],
      robotsData: openRobots,
      domainUrl: 'https://example.com',
    });
    expect(none.freshness_score).toBe(0);
    expect(scoreFreshness(none.raw_findings)).toBe(0);
  });

  it('uses the freshest date across crawled pages', () => {
    const result = runScorers({
      crawledPages: [
        page({ url: 'https://example.com', lastModified: daysAgo(300) }),
        page({ url: 'https://example.com/blog', lastModified: daysAgo(5) }),
      ],
      robotsData: openRobots,
      domainUrl: 'https://example.com',
    });
    expect(result.freshness_score).toBe(100);
  });

  it('answerability can now exceed 70 — the 30 sitemap points were unreachable', () => {
    const withoutSitemap = runScorers({
      crawledPages: [page()],
      robotsData: openRobots,
      domainUrl: 'https://example.com',
    });
    expect(withoutSitemap.answerability_score).toBe(70);

    const withSitemap = runScorers({
      crawledPages: [page()],
      robotsData: openRobots,
      domainUrl: 'https://example.com',
      sitemapUrls: ['https://example.com/', 'https://example.com/pricing'],
    });
    expect(withSitemap.answerability_score).toBe(100);
    expect(scoreAiCrawler(withSitemap.raw_findings)).toBe(100);
  });

  it('an omitted sitemapUrls scores the same as having no sitemap', () => {
    const omitted = runScorers({
      crawledPages: [page()],
      robotsData: openRobots,
      domainUrl: 'https://example.com',
    });
    expect(omitted.raw_findings.sitemapListed).toBe(false);
  });

  it('a perfect site is no longer capped below A+', () => {
    const perfect = runScorers({
      crawledPages: [
        page({
          lastModified: daysAgo(3),
          structuredDataTypes: ['Organization', 'FAQPage', 'Article'],
          externalLinks: ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com', 'https://e.com'],
        }),
      ],
      robotsData: openRobots,
      domainUrl: 'https://example.com',
      sitemapUrls: ['https://example.com/'],
    });
    expect(perfect.answerability_score).toBe(100);
    expect(perfect.freshness_score).toBe(100);
    expect(perfect.overall_grade).toBe('A+');
  });
});
