import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { runScorers, computeOverall, probeTotals } from '@/lib/scoring';
import { probeClaudeVisibility } from '@/lib/auditor/ai-probe';
import { crawlSite } from '@/lib/auditor/crawl';
import type { CrawlPage } from '@/types/audit';

export const maxDuration = 60;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const crawlSchema = z.object({
  auditId: z.string().uuid(),
  domainUrl: z.string().url(),
});

const MAX_PAGES = 50;
/* Below this route's maxDuration of 60s, so the crawl ends on its own terms and the
   handler still reaches its status writes. */
const CRAWL_BUDGET_MS = 45_000;

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
    const { crawledPages, robotsData, sitemapUrls, budgetExhausted } = await crawlSite(domainUrl, {
      maxPages: MAX_PAGES,
      budgetMs: CRAWL_BUDGET_MS,
    });

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
