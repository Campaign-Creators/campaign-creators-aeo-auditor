import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { syncAeoLead, type AeoLeadPayload } from '@/lib/hubspot';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { unlockCookieName, unlockRefusal, unlockToken } from '@/lib/gate';
import { staffEmail } from '@/lib/staff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Domains reserved for examples and testing (RFC 2606 / 6761): never a real contact. */
function isReservedEmailDomain(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const labels = domain.split('.');
  const tld = labels.at(-1) ?? '';
  if (['test', 'example', 'invalid', 'localhost'].includes(tld)) return true;
  const base = labels.slice(-2).join('.');
  return ['example.com', 'example.net', 'example.org'].includes(base);
}

const unlockSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().max(254).email()
    .refine(e => !isReservedEmailDomain(e), { message: 'Enter your work email.' }),
});

/** Distinct emails one audit accepts. A shared report gets a few readers, not dozens. */
const LEADS_PER_AUDIT_MAX = 5;

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
 * Other checks below: the audit must be finished, the address must be real-looking, a
 * repeat reader writes nothing new, and each audit accepts a few readers. The CRM sync
 * fills blank fields only (lib/hubspot.ts).
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

  if (!UUID_REGEX.test(auditId)) {
    return NextResponse.json({ error: 'Invalid auditId' }, { status: 400 });
  }

  // Staff (FR-014) see the full report without the form: no lead, no CRM sync.
  const staff = await staffEmail(request);

  let name = '';
  let email = '';
  if (!staff) {
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
    ({ name, email } = parsed.data);
  }

  const supabase = getSupabase();

  // Fetch audit request + results in one go
  const { data: audit } = await supabase
    .from('audit_requests')
    .select('id, url, status, created_at')
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

  const notReady = unlockRefusal(auditId, audit.status, !!result);
  if (notReady) return NextResponse.json(notReady.body, { status: notReady.status });

  if (staff) {
    console.log('[unlock] staff view for audit', auditId);
    // Session only: staff unlock again on each visit, so their cookies don't pile up.
    return withUnlockProof(NextResponse.json({ success: true, staff: true }), auditId, { session: true });
  }

  // ── 1. Known reader, or room for a new one ───────────────────────────
  const seen = await existingLeads(supabase, auditId, email);
  if (seen?.sameEmail) {
    // Already captured: unlock again without a second write or CRM call.
    return withUnlockProof(NextResponse.json({ success: true }), auditId);
  }
  if (seen && seen.total >= LEADS_PER_AUDIT_MAX) return readerLimit(auditId);

  // ── 2. Save lead to Supabase ──────────────────────────────────────────
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
    console.log('[unlock] lead saved for audit', auditId);
    // Requests that passed the check together are counted again after writing, so the
    // ones past the limit get neither the CRM sync nor access.
    const after = seen ? await existingLeads(supabase, auditId, email) : null;
    if (after && after.total > LEADS_PER_AUDIT_MAX) return readerLimit(auditId);
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

  /* The lead's name and email used to be written here on every unlock. The row is in
     Supabase and the contact is in HubSpot; the log only needs to say which audit. */
  console.log('LEAD_CAPTURED:', JSON.stringify({ auditId }));

  // ── 3. Sync to HubSpot (async, non-blocking) ─────────────────────────
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

  return withUnlockProof(NextResponse.json({ success: true }), auditId);
}

type CountQuery = PromiseLike<{ count: number | null; error: unknown }> & { eq(c: string, v: string): CountQuery };

/**
 * This audit's lead count and whether this email is already one of them. Null when the
 * lookup fails: the caller then writes the lead as before (the write is idempotent), since
 * a dropped capture costs more than a duplicate check.
 */
async function existingLeads(
  supabase: ReturnType<typeof getSupabase>,
  auditId: string,
  email: string,
): Promise<{ total: number; sameEmail: boolean } | null> {
  const forAudit = () => (supabase.from('leads')
    .select('id', { count: 'exact', head: true }) as unknown as CountQuery)
    .eq('audit_request_id', auditId);
  const [all, same] = await Promise.all([forAudit(), forAudit().eq('email', email)]);
  if (all.error || same.error) {
    console.error('[unlock] lead lookup failed; writing the lead anyway');
    return null;
  }
  return { total: all.count ?? 0, sameEmail: (same.count ?? 0) > 0 };
}

/** Sets the signed per-audit unlock cookie when a cookie key is available. */
function withUnlockProof(res: NextResponse, auditId: string, { session = false } = {}): NextResponse {
  const proof = unlockToken(auditId);
  if (proof) {
    res.cookies.set(unlockCookieName(auditId), proof, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/',
      ...(session ? {} : { maxAge: 60 * 60 * 24 * 365 }),
    });
  }
  return res;
}

function readerLimit(auditId: string): NextResponse {
  console.log('[unlock] lead limit reached for audit', auditId);
  return NextResponse.json(
    { error: 'This report has reached its limit of readers. Run your own free audit instead.' },
    { status: 429 },
  );
}
