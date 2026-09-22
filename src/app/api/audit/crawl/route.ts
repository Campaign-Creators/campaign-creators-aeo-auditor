import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import * as cheerio from 'cheerio';
import { runScorers, getGrade, computeOverall, probeTotals } from '@/lib/scoring';
import { probeClaudeVisibility } from '@/lib/auditor/ai-probe';
import type { CrawlPage, CrawlRobotsData } from '@/types/audit';
import { pickLastModified } from '@/lib/auditor/lastModified';

export const maxDuration = 60;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const crawlSchema = z.object({
  auditId: z.string().uuid(),
  domainUrl: z.string().url(),
});

const MAX_PAGES = 50;
const MAX_H2 = 10;
const MAX_BODY_CHARS = 5000;
const MAX_LINKS_PER_PAGE = 20;
const MAX_SITEMAP_URLS = 20;
const ROBOTS_TIMEOUT_MS = 8000;
const SITEMAP_TIMEOUT_MS = 8000;
const PAGE_TIMEOUT_MS = 10000;
const PAGE_DELAY_MS = 500;
/* Below this route's maxDuration of 60s, so the crawl ends on its own terms and the
   handler still reaches its status writes. See docs/audit/01-crawler.md F5. */
const CRAWL_BUDGET_MS = 45_000;

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

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

function failedPage(
  url: string,
  message: string,
  statusCode = 0,
): CrawlPage {
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

async function crawlSinglePage(
  url: string,
  originHost: string,
): Promise<CrawlPage | null> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, PAGE_TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failedPage(url, msg, 0);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/html')) {
    return null;
  }

  let html: string;
  try {
    html = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failedPage(url, msg, res.status);
  }

  const $ = cheerio.load(html);

  // The server already told us when this page changed; the crawler used to throw it away.
  const lastModified = pickLastModified(res.headers.get('last-modified'), $);

  const title = $('title').first().text().trim() || null;
  const metaDescription =
    $('meta[name="description"]').attr('content')?.trim() || null;
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
      if (internalLinks.length < MAX_LINKS_PER_PAGE) {
        internalLinks.push(resolved.toString());
      }
    } else {
      if (externalLinks.length < MAX_LINKS_PER_PAGE) {
        externalLinks.push(resolved.toString());
      }
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
      // ignore invalid JSON-LD blocks
    }
  });

  const canonicalUrl =
    $('link[rel="canonical"]').attr('href')?.trim() || null;
  const robotsMeta =
    $('meta[name="robots"]').attr('content')?.trim() || null;

  const openGraphTags: Record<string, string> = {};
  $('meta').each((_, el) => {
    const prop = $(el).attr('property') ?? $(el).attr('name');
    const content = $(el).attr('content');
    if (!prop || !content) return;
    if (prop.toLowerCase().startsWith('og:')) {
      openGraphTags[prop] = content;
    }
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
  };
}

const GENERIC_INDUSTRY_WORDS = new Set([
  'home', 'page', 'website', 'site', 'company', 'business', 'team', 'blog', 'news',
  'contact', 'about', 'services', 'portfolio', 'case', 'studies',
]);

function extractIndustry(pages: CrawlPage[]): string {
  const texts: string[] = [];
  for (const page of pages.slice(0, 3)) {
    if (page.h1) texts.push(page.h1);
    if (page.metaDescription) texts.push(page.metaDescription);
    const ogDesc = page.openGraphTags?.['og:description'];
    if (ogDesc) texts.push(ogDesc);
  }

  for (const text of texts) {
    const segments = text.split(/[.!?]+|[,;–—|]+/).map(s => s.trim()).filter(Boolean);
    for (const seg of segments) {
      const words = seg.split(/\s+/);
      const lower = seg.toLowerCase();
      if (
        words.length >= 1 && words.length <= 5 &&
        !lower.match(/^(we |our |the |a |an |for |with |and |or )/i) &&
        !GENERIC_INDUSTRY_WORDS.has(lower)
      ) {
        return seg;
      }
    }
  }

  return texts[0]?.split(/\s+/).slice(0, 4).join(' ') || '';
}

const GENERIC_H2S = new Set([
  'about', 'contact', 'related', 'home', 'services', 'blog', 'news', 'team', 'faq',
  'portfolio', 'clients', 'partners', 'resources', 'get started', 'learn more',
  'read more', 'view all', 'next steps', 'testimonials', 'reviews', 'pricing',
  'careers', 'jobs', 'newsletter', 'subscribe',
]);

function extractTopics(pages: CrawlPage[]): string[] {
  const seen = new Set<string>();
  const services: string[] = [];

  for (const page of pages.slice(0, 10)) {
    if (!page.h2s) continue;
    for (const h2 of page.h2s) {
      const lower = h2.toLowerCase().trim();
      if (!GENERIC_H2S.has(lower) && !seen.has(lower) && h2.trim().split(/\s+/).length <= 6) {
        seen.add(lower);
        services.push(h2.trim());
        if (services.length >= 6) return services;
      }
    }
  }

  return services;
}

function extractCompanyName(pages: CrawlPage[]): string {
  for (const page of pages) {
    const siteName = page.openGraphTags?.['og:site_name'];
    if (siteName) return siteName.trim();
    const ogTitle = page.openGraphTags?.['og:title'];
    if (ogTitle) {
      const parts = ogTitle.split(/\s*[|–—]\s*/);
      return (parts.length > 1 ? parts[parts.length - 1] : ogTitle).trim();
    }
    if (page.title) {
      const parts = page.title.split(/\s*[|–—]\s*/);
      return (parts.length > 1 ? parts[parts.length - 1] : page.title).trim();
    }
  }
  return '';
}

function readBearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const expected = process.env.INTERNAL_CRAWLER_SECRET;
  const token = readBearerToken(req);
  if (!expected || !token || token !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid payload', details: 'Body must be valid JSON.' },
      { status: 400 },
    );
  }

  const parsed = crawlSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid payload', details: parsed.error.issues },
      { status: 400 },
    );
  }
  const { auditId, domainUrl } = parsed.data;

  const supabaseUrl = (
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  ).trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  await supabase
    .from('audit_requests')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', auditId);

  try {
    const originUrl = new URL(domainUrl);
    const originHost = originUrl.hostname;
    const origin = originUrl.origin;

    // robots.txt
    let robotsText = '';
    let robotsData: CrawlRobotsData = emptyRobots();
    try {
      const res = await fetchWithTimeout(
        `${origin}/robots.txt`,
        ROBOTS_TIMEOUT_MS,
      );
      if (res.ok) {
        robotsText = await res.text();
        robotsData = parseRobots(robotsText);
      }
    } catch {
      // leave robotsData empty; raw stays ''
    }

    // sitemap discovery
    let sitemapUrls: string[] = [];
    const hints = extractSitemapHintsFromRobots(robotsText);
    const sitemapTarget = hints[0] ?? `${origin}/sitemap.xml`;
    try {
      const res = await fetchWithTimeout(sitemapTarget, SITEMAP_TIMEOUT_MS);
      if (res.ok) {
        const xml = await res.text();
        sitemapUrls = parseSitemapXml(xml, MAX_SITEMAP_URLS);
      }
    } catch {
      sitemapUrls = [];
    }

    // candidate list: dedupe (raw string match), start with domainUrl
    const visited = new Set<string>();
    const candidates: string[] = [];
    const pushCandidate = (u: string): void => {
      if (!visited.has(u)) {
        visited.add(u);
        candidates.push(u);
      }
    };
    pushCandidate(domainUrl);
    for (const u of sitemapUrls) pushCandidate(u);

    // crawl up to MAX_PAGES HTML pages; non-HTML are skipped and not counted
    const crawledPages: CrawlPage[] = [];
    const deadline = Date.now() + CRAWL_BUDGET_MS;
    let budgetExhausted = false;
    for (
      let i = 0;
      i < candidates.length && crawledPages.length < MAX_PAGES;
      i++
    ) {
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
      // Feed discovered internal links back into the candidate queue
      if (page.internalLinks) {
        for (const link of page.internalLinks) {
          pushCandidate(link);
        }
      }
    }

    const scored = runScorers({ crawledPages, robotsData, domainUrl, sitemapUrls });

    let aiProbe = null;
    try {
      const industry = extractIndustry(crawledPages);
      const topics = extractTopics(crawledPages);
      const companyName = extractCompanyName(crawledPages);
      aiProbe = await probeClaudeVisibility(domainUrl, companyName, industry, topics);
    } catch (err) {
      console.error('AI probe failed:', err);
    }

    // Persist into actual audit_results schema. The DB column is `raw_findings`
    // (JSONB) — we extend the standard RawFindings shape with the full crawl
    // payload so both the status route (which reads RawFindings) and the spec's
    // raw_crawl_data intent are satisfied.
    const rawFindings = {
      ...scored.raw_findings,
      pages: crawledPages,
      robots: robotsData,
      aiProbe,
      crawlTruncated: budgetExhausted,
    };

    // One implementation, shared with lib/inngest/functions.ts. When the probe returns nothing
    // this no longer silently redistributes its 40% across the other five — see computeOverall().
    const overall = computeOverall(scored, probeTotals(aiProbe));
    const overallScore = overall.overall_score;
    const overallGrade = overall.overall_grade;

    // Recorded so a grade can be explained after the fact. There is no column for this yet, and
    // raw_findings is already JSONB, so the fix ships without waiting on a migration.
    rawFindings.aiProbeStatus = overall.ai_probe_status;
    rawFindings.aiCitationScore = overall.ai_citation_score;
    rawFindings.aiPromptsTotal = overall.ai_prompts_total;
    rawFindings.aiCitedCount = overall.ai_cited_count;

    await supabase
      .from('audit_results')
      .upsert(
        {
          audit_request_id: auditId,
          answerability_score: Math.round(scored.answerability_score),
          answerability_grade: scored.answerability_grade,
          structure_score: Math.round(scored.structure_score),
          structure_grade: scored.structure_grade,
          trust_score: Math.round(scored.trust_score),
          trust_grade: scored.trust_grade,
          freshness_score: Math.round(scored.freshness_score),
          freshness_grade: scored.freshness_grade,
          brevity_score: Math.round(scored.brevity_score),
          brevity_grade: scored.brevity_grade,
          overall_score: overallScore,
          overall_grade: overallGrade,
          raw_findings: rawFindings,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'audit_request_id' },
      );

    await supabase
      .from('audit_requests')
      .update({ status: 'complete', updated_at: new Date().toISOString() })
      .eq('id', auditId);

    return NextResponse.json({ success: true, auditId }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    try {
      await supabase
        .from('audit_requests')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', auditId);
    } catch {
      // best-effort; surfacing the original error is more important
    }
    return NextResponse.json(
      { error: 'Crawl failed', message },
      { status: 500 },
    );
  }
}
