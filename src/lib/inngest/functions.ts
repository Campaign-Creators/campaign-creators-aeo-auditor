import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { inngest } from './client';
import { runScorers, getGrade, computeOverall, probeTotals } from '@/lib/scoring';
import { probeWithPrompts, probeOpenAI, probePerplexity, probeGoogleAI } from '@/lib/auditor/ai-probe';
import type { CrawlPage, CrawlRobotsData } from '@/types/audit';
import { pickLastModified } from '@/lib/auditor/lastModified';

const MAX_PAGES = 200;
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

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
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
  try {
    res = await fetchWithTimeout(url, PAGE_TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failedPage(url, msg, 0);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/html')) return null;

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
  };
}

async function generateSmartPrompts(pages: CrawlPage[], domain: string): Promise<{ companyName: string; industry: string; prompts: string[] }> {
  const client = new Anthropic();

  const homepage = pages[0];
  const siteContext = [
    `Domain: ${domain}`,
    `Title: ${homepage?.title || ''}`,
    `H1: ${homepage?.h1 || ''}`,
    `Meta description: ${homepage?.metaDescription || ''}`,
    `Key pages: ${pages.slice(0, 10).map(p => p.title || p.h1 || p.url).join('; ')}`,
    `H2 headings: ${pages.flatMap(p => p.h2s || []).slice(0, 15).join('; ')}`,
  ].join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Analyze this website and generate search prompts.

${siteContext}

Return ONLY a JSON object with:
1. "companyName": the company/brand name (e.g. "SmartBug Media", "Campaign Creators")
2. "industry": a 2-4 word industry description (e.g. "HubSpot marketing agency", "B2B SaaS consulting", "ecommerce platform")
3. "prompts": an array of exactly 10 questions that a potential customer would type into ChatGPT when looking for this type of company. Make them natural, specific to the industry, and varied. Examples of good prompts:
   - "What are the best HubSpot partner agencies for enterprise companies?"
   - "Which marketing agencies specialize in B2B lead generation?"
   - "Who are the top inbound marketing consultants in 2026?"
   Do NOT use the company's own marketing copy. Write questions a buyer would ask BEFORE they know about this company.

Return valid JSON only, no markdown fences.`,
    }],
  });

  try {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const parsed = JSON.parse(text.trim());
    return {
      companyName: parsed.companyName || domain.replace(/^www\./, '').split('.')[0],
      industry: parsed.industry || 'digital services',
      prompts: Array.isArray(parsed.prompts) ? parsed.prompts.slice(0, 10) : [],
    };
  } catch {
    return {
      companyName: domain.replace(/^www\./, '').split('.')[0],
      industry: 'digital services',
      prompts: [
        `What are the best companies in the ${domain} industry?`,
        `Which agencies would you recommend for businesses like ${domain}?`,
        `Who are the top providers competing with ${domain}?`,
        `What are the leading alternatives to ${domain}?`,
        `Compare top providers similar to ${domain} for enterprise customers`,
        `Which companies offer services like ${domain}?`,
        `What are the most reputable alternatives to ${domain}?`,
        `Who are the emerging leaders alongside ${domain}?`,
        `What should I look for when choosing a provider like ${domain}?`,
        `Best solutions in the same category as ${domain}`,
      ],
    };
  }
}

export const runAudit = inngest.createFunction(
  { id: 'run-audit', retries: 1, triggers: [{ event: 'audit/requested' }] },
  async ({ event, step }) => {
    const { auditId, domainUrl } = event.data as { auditId: string; domainUrl: string };

    const supabaseUrl = (
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
    ).trim();
    const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    await step.run('update-status-processing', async () => {
      await supabase
        .from('audit_requests')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', auditId);
    });

    const crawlResult = await step.run('crawl-site', async () => {
      const originUrl = new URL(domainUrl);
      const originHost = originUrl.hostname;
      const origin = originUrl.origin;

      let robotsText = '';
      let robotsData: CrawlRobotsData = emptyRobots();
      try {
        const res = await fetchWithTimeout(`${origin}/robots.txt`, ROBOTS_TIMEOUT_MS);
        if (res.ok) {
          robotsText = await res.text();
          robotsData = parseRobots(robotsText);
        }
      } catch {
        // leave robotsData empty
      }

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

      const crawledPages: CrawlPage[] = [];
      for (let i = 0; i < candidates.length && crawledPages.length < MAX_PAGES; i++) {
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

      return { crawledPages, robotsData, sitemapUrls };
    });

    const aiProbeResult = await step.run('ai-probe', async () => {
      const { crawledPages } = crawlResult;
      const { companyName, prompts } = await generateSmartPrompts(crawledPages, new URL(domainUrl).hostname);
      const [claudeResult, openaiResult, perplexityResult, googleResult] = await Promise.all([
        probeWithPrompts(domainUrl, companyName, prompts).catch((err) => {
          console.error('Claude probe failed:', err);
          return null;
        }),
        probeOpenAI(domainUrl, companyName, prompts),
        probePerplexity(domainUrl, companyName, prompts),
        probeGoogleAI(domainUrl, companyName, prompts),
      ]);
      return {
        claude: claudeResult,
        openai: openaiResult,
        perplexity: perplexityResult,
        google: googleResult,
        prompts,
      };
    });

    await step.run('store-results', async () => {
      const { crawledPages, robotsData, sitemapUrls } = crawlResult;
      const scored = runScorers({ crawledPages, robotsData, domainUrl, sitemapUrls });

      const rawFindings = {
        ...scored.raw_findings,
        pages: crawledPages,
        robots: robotsData,
        aiProbe: aiProbeResult,
      };

      // One implementation, shared with app/api/audit/crawl/route.ts. probeTotals() sums the
      // four engines here and reads a single result object there, so neither call site has to
      // know how the other probes.
      const overall = computeOverall(scored, probeTotals(aiProbeResult));
      const overallScore = overall.overall_score;
      const overallGrade = overall.overall_grade;

      rawFindings.aiProbeStatus = overall.ai_probe_status;
      rawFindings.aiCitationScore = overall.ai_citation_score;
      rawFindings.aiPromptsTotal = overall.ai_prompts_total;
      rawFindings.aiCitedCount = overall.ai_cited_count;

      await supabase.from('audit_results').upsert(
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
    });

    return { success: true };
  },
);
