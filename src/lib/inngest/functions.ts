import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { inngest } from './client';
import { runScorers, computeOverall, probeTotals } from '@/lib/scoring';
import { probeWithPrompts, probeOpenAI, probePerplexity, probeGoogleAI } from '@/lib/auditor/ai-probe';
import { crawlSite } from '@/lib/auditor/crawl';
import type { CrawlPage } from '@/types/audit';

const MAX_PAGES = 200;
/* Stop crawling before the platform kills the invocation. A crawl that runs out of
   time now returns what it has; it used to be killed mid-step, which skipped every
   status write and left the audit in `processing` forever. */
const CRAWL_BUDGET_MS = 240_000;

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
  {
    id: 'run-audit',
    retries: 1,
    triggers: [{ event: 'audit/requested' }],
    /* Nothing wrote `failed` before this. The handler's own catch only fires for errors
       it survives to catch: a platform timeout kills the process first. onFailure runs
       after retries are exhausted, whatever the cause, so the row stops claiming to be
       in progress and the visitor's page stops spinning. */
    onFailure: async ({ event, error }) => {
      const original = event.data.event?.data as { auditId?: string } | undefined;
      const auditId = original?.auditId;
      if (!auditId) {
        console.error('[run-audit] failed with no auditId in the triggering event:', error?.message);
        return;
      }
      const supabase = createClient(
        (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
        (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
      );
      const { error: writeError } = await supabase
        .from('audit_requests')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', auditId);
      if (writeError) {
        console.error('[run-audit] could not mark audit failed:', JSON.stringify(writeError));
      } else {
        console.error(`[run-audit] audit ${auditId} marked failed: ${error?.message ?? 'unknown error'}`);
      }
    },
  },
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

    const crawlResult = await step.run('crawl-site', () =>
      crawlSite(domainUrl, { maxPages: MAX_PAGES, budgetMs: CRAWL_BUDGET_MS }),
    );

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
      const { crawledPages, robotsData, sitemapUrls, budgetExhausted } = crawlResult;
      const scored = runScorers({ crawledPages, robotsData, domainUrl, sitemapUrls });

      const rawFindings = {
        ...scored.raw_findings,
        pages: crawledPages,
        robots: robotsData,
        aiProbe: aiProbeResult,
        crawlTruncated: budgetExhausted,
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
