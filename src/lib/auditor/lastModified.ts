/**
 * Date extraction for the freshness dimension.
 *
 * `scoreFreshness` has always been implemented — 30/90/180/365-day buckets — but
 * `deriveFindingsFromCrawl` passed it `lastModified: null` unconditionally, so every
 * audit ever run scored 0 on freshness (see docs/audit/01-crawler.md, F1). The crawler
 * discarded the `Last-Modified` header it received on every page.
 *
 * This module is the missing input. It lives on its own because the crawl loop exists
 * twice — in the Inngest function and in the fallback route — and a third copy of the
 * extraction logic is exactly how those two drifted apart in the first place.
 */

import type { CheerioAPI } from 'cheerio';

/** Reject dates that cannot be real page dates rather than letting them skew the score. */
const EARLIEST_PLAUSIBLE = Date.UTC(2000, 0, 1);
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = new Date(value.trim()).getTime();
  if (Number.isNaN(ms)) return null;
  if (ms < EARLIEST_PLAUSIBLE) return null;
  if (ms > Date.now() + FUTURE_TOLERANCE_MS) return null;
  return new Date(ms).toISOString();
}

/** The most recent of two ISO dates, ignoring nulls. */
export function newerDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function fromJsonLd($: CheerioAPI): string | null {
  let best: string | null = null;

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const key of ['dateModified', 'datePublished']) {
      const raw = obj[key];
      if (typeof raw === 'string') best = newerDate(best, normalize(raw));
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') walk(value);
    }
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).contents().text().trim();
    if (!text) return;
    try {
      walk(JSON.parse(text));
    } catch {
      // Invalid JSON-LD is already ignored by the structured-data check; same here.
    }
  });

  return best;
}

/**
 * Best available modification date for one crawled page, as an ISO string, or null.
 *
 * Order is most-trustworthy first: the HTTP header the server itself set, then the
 * page's own structured claims. A missing date stays null — freshness then scores 0,
 * which is the correct answer for a page that publishes no date at all, and is what
 * the report should say.
 */
export function pickLastModified(
  headerValue: string | null | undefined,
  $?: CheerioAPI,
): string | null {
  const fromHeader = normalize(headerValue);
  if (fromHeader) return fromHeader;
  if (!$) return null;

  const metaCandidates = [
    $('meta[property="article:modified_time"]').attr('content'),
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[name="last-modified"]').attr('content'),
    $('meta[itemprop="dateModified"]').attr('content'),
  ];
  for (const candidate of metaCandidates) {
    const normalized = normalize(candidate);
    if (normalized) return normalized;
  }

  const fromLd = fromJsonLd($);
  if (fromLd) return fromLd;

  const timeAttr = $('time[datetime]').first().attr('datetime');
  return normalize(timeAttr);
}
