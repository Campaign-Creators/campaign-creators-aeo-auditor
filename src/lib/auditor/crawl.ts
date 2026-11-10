import * as cheerio from 'cheerio';
import type { CrawlPage, CrawlRobotsData } from '@/types/audit';
import { pickLastModified } from '@/lib/auditor/lastModified';
import { safeFetch, isFetchableUrl, BlockedUrlError, readBodyInfo, timeLeft } from '@/lib/safeFetch';

/* The one crawler, used by the Inngest pipeline and the fallback crawl route alike, so the
   same site crawls and scores the same through either path. Each caller sets its own page
   limit and time budget to fit its platform timeout. */

const MAX_H2 = 10;
const MAX_BODY_CHARS = 5000;
const MAX_LINKS_PER_PAGE = 20;
const MAX_SITEMAP_URLS = 20;
const ROBOTS_TIMEOUT_MS = 8000;
const SITEMAP_TIMEOUT_MS = 8000;
const PAGE_TIMEOUT_MS = 10000;
const PAGE_DELAY_MS = 500;

function emptyRobots(): CrawlRobotsData {
  return {
    raw: '',
    gptBotDisallowed: false,
    claudeBotDisallowed: false,
    googlebotDisallowed: false,
    bingbotDisallowed: false,
    fullDisallowAll: false,
  };
}

type RobotsBlock = {
  agents: string[];
  disallows: string[];
  allows: string[];
};

function parseRobots(text: string): CrawlRobotsData {
  const blocks: RobotsBlock[] = [];
  let current: RobotsBlock | null = null;
  let inAgentRun = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) {
      inAgentRun = false;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!current || !inAgentRun) {
        current = { agents: [], disallows: [], allows: [] };
        blocks.push(current);
      }
      current.agents.push(value.toLowerCase());
      inAgentRun = true;
    } else if (field === 'disallow') {
      current?.disallows.push(value);
      inAgentRun = false;
    } else if (field === 'allow') {
      current?.allows.push(value);
      inAgentRun = false;
    } else {
      inAgentRun = false;
    }
  }

  const disallowedFor = (bot: string): boolean => {
    const lower = bot.toLowerCase();
    return blocks
      .filter((b) => b.agents.includes(lower))
      .some((b) => b.disallows.includes('/'));
  };

  const fullDisallowAll = blocks
    .filter((b) => b.agents.includes('*'))
    .some((b) => b.disallows.includes('/'));

  return {
    raw: text,
    gptBotDisallowed: disallowedFor('GPTBot'),
    claudeBotDisallowed: disallowedFor('ClaudeBot'),
    googlebotDisallowed: disallowedFor('Googlebot'),
    bingbotDisallowed: disallowedFor('Bingbot'),
    fullDisallowAll,
  };
}

function extractSitemapHintsFromRobots(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*Sitemap\s*:\s*(\S+)/i);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function parseSitemapXml(xml: string, limit = MAX_SITEMAP_URLS): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].trim());
    if (out.length >= limit) break;
  }
  return out;
}

/* Every crawler fetch goes through safeFetch: the host guard runs before each request
   and each redirect hop. See lib/safeFetch.ts. */
function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  return safeFetch(url, { timeoutMs });
}

function failedPage(url: string, message: string, statusCode = 0): CrawlPage {
  return {
    url,
    statusCode,
    title: null,
    metaDescription: null,
    h1: null,
    h2s: [],
    bodyText: '',
    wordCount: 0,
    internalLinks: [],
    externalLinks: [],
    hasStructuredData: false,
    structuredDataTypes: [],
    canonicalUrl: null,
    robotsMeta: null,
    openGraphTags: {},
    lastModified: null,
    fetchError: message,
  };
}

function collectJsonLdTypes(node: unknown, sink: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdTypes(item, sink);
    return;
  }
  const obj = node as Record<string, unknown>;
  const t = obj['@type'];
  if (typeof t === 'string') sink.push(t);
  else if (Array.isArray(t)) {
    for (const v of t) if (typeof v === 'string') sink.push(v);
  }
  if (Array.isArray(obj['@graph'])) collectJsonLdTypes(obj['@graph'], sink);
}

async function crawlSinglePage(url: string, originHost: string): Promise<CrawlPage | null> {
  let res: Response;
  const started = Date.now();
  try {
    res = await fetchWithTimeout(url, PAGE_TIMEOUT_MS);
  } catch (err) {
    // A redirect to a refused host is skipped like a non-HTML page, not scored as a failure.
    if (err instanceof BlockedUrlError) return null;
    const msg = err instanceof Error ? err.message : String(err);
    return failedPage(url, msg, 0);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/html')) return null;

  let html: string;
  let truncated: boolean;
  try {
    ({ text: html, truncated } = await readBodyInfo(res, { timeoutMs: timeLeft(started, PAGE_TIMEOUT_MS) }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failedPage(url, msg, res.status);
  }

  const $ = cheerio.load(html);

  // The server already told us when this page changed; the crawler used to throw it away.
  const lastModified = pickLastModified(res.headers.get('last-modified'), $);

  const title = $('title').first().text().trim() || null;
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;
  const h1 = $('h1').first().text().trim() || null;

  const h2s: string[] = [];
  $('h2').each((_, el) => {
    if (h2s.length >= MAX_H2) return false;
    const t = $(el).text().trim();
    if (t) h2s.push(t);
  });

  const rawBody = $('body').text().replace(/\s+/g, ' ').trim();
  const bodyText = rawBody.slice(0, MAX_BODY_CHARS);
  const wordCount = rawBody ? rawBody.split(/\s+/).length : 0;

  const internalLinks: string[] = [];
  const externalLinks: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let resolved: URL;
    try {
      resolved = new URL(href, url);
    } catch {
      return;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return;
    if (resolved.hostname === originHost) {
      if (internalLinks.length < MAX_LINKS_PER_PAGE) internalLinks.push(resolved.toString());
    } else {
      if (externalLinks.length < MAX_LINKS_PER_PAGE) externalLinks.push(resolved.toString());
    }
  });

  const structuredDataTypes: string[] = [];
  let hasStructuredData = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).contents().text().trim();
    if (!text) return;
    hasStructuredData = true;
    try {
      collectJsonLdTypes(JSON.parse(text), structuredDataTypes);
    } catch {
      // ignore invalid JSON-LD
    }
  });

  const canonicalUrl = $('link[rel="canonical"]').attr('href')?.trim() || null;
  const robotsMeta = $('meta[name="robots"]').attr('content')?.trim() || null;

  const openGraphTags: Record<string, string> = {};
  $('meta').each((_, el) => {
    const prop = $(el).attr('property') ?? $(el).attr('name');
    const content = $(el).attr('content');
    if (!prop || !content) return;
    if (prop.toLowerCase().startsWith('og:')) openGraphTags[prop] = content;
  });

  return {
    url,
    statusCode: res.status,
    title,
    metaDescription,
    h1,
    h2s,
    bodyText,
    wordCount,
    internalLinks,
    externalLinks,
    hasStructuredData,
    structuredDataTypes,
    canonicalUrl,
    robotsMeta,
    openGraphTags,
    lastModified,
    fetchError: null,
    ...(truncated ? { truncated } : {}),
  };
}

export interface CrawlResult {
  crawledPages: CrawlPage[];
  robotsData: CrawlRobotsData;
  sitemapUrls: string[];
  budgetExhausted: boolean;
}

/**
 * robots.txt, the sitemap, then pages breadth-first, all inside one time budget: the
 * robots and sitemap fetches take their time out of it too, so the whole crawl ends by
 * `budgetMs` (plus at most one page's timeout) whatever the site does.
 */
export async function crawlSite(
  domainUrl: string,
  { maxPages, budgetMs }: { maxPages: number; budgetMs: number },
): Promise<CrawlResult> {
  const deadline = Date.now() + budgetMs;
  const within = (capMs: number) => Math.min(capMs, deadline - Date.now());
  const originUrl = new URL(domainUrl);
  const originHost = originUrl.hostname;
  const origin = originUrl.origin;

  let robotsText = '';
  let robotsData: CrawlRobotsData = emptyRobots();
  const robotsMs = within(ROBOTS_TIMEOUT_MS);
  if (robotsMs > 0) {
    try {
      const started = Date.now();
      const res = await fetchWithTimeout(`${origin}/robots.txt`, robotsMs);
      if (res.ok) {
        robotsText = (await readBodyInfo(res, { timeoutMs: timeLeft(started, robotsMs) })).text;
        robotsData = parseRobots(robotsText);
      }
    } catch {
      // leave robotsData empty
    }
  }

  let sitemapUrls: string[] = [];
  const hints = extractSitemapHintsFromRobots(robotsText);
  const sitemapTarget = hints[0] ?? `${origin}/sitemap.xml`;
  const sitemapMs = within(SITEMAP_TIMEOUT_MS);
  if (sitemapMs > 0) {
    try {
      const started = Date.now();
      const res = await fetchWithTimeout(sitemapTarget, sitemapMs);
      if (res.ok) {
        const xml = (await readBodyInfo(res, { timeoutMs: timeLeft(started, sitemapMs) })).text;
        sitemapUrls = parseSitemapXml(xml, MAX_SITEMAP_URLS);
      }
    } catch {
      sitemapUrls = [];
    }
  }

  const visited = new Set<string>();
  const candidates: string[] = [];
  const pushCandidate = (u: string): void => {
    if (!isFetchableUrl(u)) return;
    if (!visited.has(u)) {
      visited.add(u);
      candidates.push(u);
    }
  };
  pushCandidate(domainUrl);
  for (const u of sitemapUrls) pushCandidate(u);

  const crawledPages: CrawlPage[] = [];
  let budgetExhausted = false;
  for (let i = 0; i < candidates.length && crawledPages.length < maxPages; i++) {
    if (Date.now() >= deadline) {
      budgetExhausted = true;
      console.warn(
        `[crawl] budget reached for ${domainUrl} after ${crawledPages.length} pages; scoring what we have`,
      );
      break;
    }
    if (crawledPages.length > 0) {
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
    const page = await crawlSinglePage(candidates[i], originHost);
    if (page === null) continue;
    crawledPages.push(page);
    if (page.internalLinks) {
      for (const link of page.internalLinks) pushCandidate(link);
    }
  }

  return { crawledPages, robotsData, sitemapUrls, budgetExhausted };
}
