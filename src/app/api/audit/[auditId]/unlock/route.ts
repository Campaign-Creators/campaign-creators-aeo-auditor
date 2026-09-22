import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { syncAeoLead, type AeoLeadPayload } from '@/lib/hubspot';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const unlockSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().max(254).email(),
});

// Engine display names for HubSpot properties
const ENGINE_NAMES: Record<string, string> = {
  claude: 'Claude',
  openai: 'ChatGPT',
  perplexity: 'Perplexity',
  google: 'Google AI',
};

// Identify the lowest-scoring dimension
function findTopWeakness(result: {
  answerability_score: number | null;
  structure_score: number | null;
  trust_score: number | null;
  freshness_score: number | null;
  brevity_score: number | null;
}): string {
  const dimensions: Array<{ name: string; score: number }> = [
    { name: 'AI Crawlability', score: result.answerability_score ?? 0 },
    { name: 'Content Structure', score: result.structure_score ?? 0 },
    { name: 'Authority & Trust', score: result.trust_score ?? 0 },
    { name: 'Freshness', score: result.freshness_score ?? 0 },
    { name: 'Schema Markup', score: result.brevity_score ?? 0 },
  ];
  dimensions.sort((a, b) => a.score - b.score);
  return dimensions[0]?.name ?? 'Unknown';
}

/**
 * Unlocks are rate limited on their own budget, separate from the one that governs
 * starting an audit, so a visitor running several audits cannot exhaust their own
 * ability to read the reports.
 *
 * This is defence in depth, not the protection that matters: one request is enough to
 * write a contact, so the limit changes how fast, not whether. What stops an unlock from
 * damaging an existing CRM record is that the sync now fills blank fields only —
 * see lib/hubspot.ts and docs/audit/03-hubspot.md H1.
 */
const UNLOCK_LIMIT = Number.parseInt(process.env.RATE_LIMIT_UNLOCK_MAX ?? '10', 10) || 10;

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ auditId: string }> },
): Promise<Response> {
  const { auditId } = await ctx.params;

  try {
    const { limited } = await checkRateLimit(`unlock:${getClientIp(request)}`, UNLOCK_LIMIT);
    if (limited) {
      return NextResponse.json(
        { error: 'Too many unlock attempts. Try again later.', retryAfterSeconds: 3600 },
        { status: 429, headers: { 'Retry-After': '3600' } },
      );
    }
  } catch (err) {
    /* Fail open. A database hiccup in the limiter must not cost a real lead — the CRM
       itself is protected by the fill-if-empty rule, so an unlimited unlock is a
       nuisance, while a dropped capture is a lost customer. */
    console.error('[unlock] rate limit check failed; allowing the request:', err);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = unlockSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  const { name, email } = parsed.data;
  const supabase = getSupabase();

  // Fetch audit request + results in one go
  const { data: audit } = await supabase
    .from('audit_requests')
    .select('id, url, created_at')
    .eq('id', auditId)
    .maybeSingle();

  if (!audit) {
    return NextResponse.json({ error: 'Audit not found' }, { status: 404 });
  }

  const { data: result } = await supabase
    .from('audit_results')
    .select('*')
    .eq('audit_request_id', auditId)
    .maybeSingle();

  // ── 1. Save lead to Supabase ──────────────────────────────────────────
  const { error: leadError } = await supabase.from('leads').upsert(
    {
      audit_request_id: auditId,
      email,
      name,
    },
    { onConflict: 'email,audit_request_id' },
  );
  if (leadError) {
    console.error('[unlock] Supabase leads upsert failed:', JSON.stringify(leadError));
  } else {
    console.log('[unlock] Lead saved to Supabase:', email);
  }

  // Touch the audit_requests updated_at
  try {
    await supabase
      .from('audit_requests')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', auditId);
  } catch {
    /* ignore */
  }

  console.log('LEAD_CAPTURED:', JSON.stringify({ auditId, name, email }));

  // ── 2. Sync to HubSpot (async, non-blocking) ─────────────────────────
  // Fire-and-forget so the user isn't waiting on HubSpot
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://aeo.campaigncreators.com').replace(/\/$/, '');

  if (result) {
    const rawFindings = result.raw_findings as {
      aiProbe?: {
        claude?: { citedCount?: number; totalPrompts?: number } | null;
        openai?: { citedCount?: number; totalPrompts?: number } | null;
        perplexity?: { citedCount?: number; totalPrompts?: number } | null;
        google?: { citedCount?: number; totalPrompts?: number } | null;
      } | null;
    } | null;

    // Determine which engines cited / missed
    const enginesCited: string[] = [];
    const enginesMissing: string[] = [];
    let totalCited = 0;
    let totalPrompts = 0;

    if (rawFindings?.aiProbe) {
      for (const [key, displayName] of Object.entries(ENGINE_NAMES)) {
        const engine = rawFindings.aiProbe[key as keyof typeof rawFindings.aiProbe];
        if (engine && typeof engine.totalPrompts === 'number' && engine.totalPrompts > 0) {
          totalCited += engine.citedCount ?? 0;
          totalPrompts += engine.totalPrompts;
          if ((engine.citedCount ?? 0) > 0) {
            enginesCited.push(displayName);
          } else {
            enginesMissing.push(displayName);
          }
        } else {
          enginesMissing.push(displayName);
        }
      }
    }

    const payload: AeoLeadPayload = {
      fullName: name,
      email,
      auditedDomain: audit.url,
      auditReportUrl: `${appUrl}/audit/${auditId}`,
      overallScore: result.overall_score ?? 0,
      overallGrade: result.overall_grade ?? 'F',
      answerabilityScore: result.answerability_score ?? 0,
      structureScore: result.structure_score ?? 0,
      trustScore: result.trust_score ?? 0,
      freshnessScore: result.freshness_score ?? 0,
      schemaScore: result.brevity_score ?? 0,
      enginesCited,
      enginesMissing,
      citationRate: `${totalCited}/${totalPrompts}`,
      topWeakness: findTopWeakness(result),
      auditDate: audit.created_at,
    };

    // Await so Vercel doesn't kill the function before HubSpot calls complete
    try {
      const hsResult = await syncAeoLead(payload);
      console.log('[hubspot] Sync result:', hsResult ? `contact ${hsResult.id}` : 'skipped');
    } catch (err) {
      console.error('[unlock] HubSpot sync failed:', err);
    }
  } else {
    console.warn('[unlock] No audit results found for HubSpot sync — audit may still be processing');
  }

  return NextResponse.json({ success: true });
}
