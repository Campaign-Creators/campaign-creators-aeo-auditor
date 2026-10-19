import { NextResponse, type NextRequest } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  probeWithPrompts,
  probeOpenAI,
  probePerplexity,
  probeGoogleAI,
} from '@/lib/auditor/ai-probe';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function getSupabase(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/* Each run calls four paid AI engines, so runs are capped server-side on two budgets in
   the shared hourly limiter: per visitor IP, and per audit. Both reserve before counting,
   so simultaneous requests cannot all pass. Changing these is a cost decision. */
const CUSTOM_PROMPTS_PER_IP = 3;
const CUSTOM_PROMPTS_PER_AUDIT = 1;

/* A ceiling on runs from all visitors together in the hour, so many IPs cannot add up to an
   unbounded bill. Set CUSTOM_PROMPTS_GLOBAL_MAX to change it; anything not a positive
   integer falls back to the default. */
const DEFAULT_CUSTOM_PROMPTS_GLOBAL_MAX = 30;

function globalMax(): number {
  const raw = (process.env.CUSTOM_PROMPTS_GLOBAL_MAX ?? '').trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : 0;
  return n > 0 ? n : DEFAULT_CUSTOM_PROMPTS_GLOBAL_MAX;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ auditId: string }> },
): Promise<Response> {
  const { auditId } = await ctx.params;

  if (!UUID_REGEX.test(auditId)) {
    return NextResponse.json({ error: 'Invalid auditId' }, { status: 400 });
  }

  let body: { prompts: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!Array.isArray(body.prompts)) {
    return NextResponse.json({ error: 'prompts must be an array' }, { status: 400 });
  }

  const rawPrompts = body.prompts as unknown[];
  const validPrompts = rawPrompts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map(p => p.trim().slice(0, 200));

  if (validPrompts.length === 0 || validPrompts.length > 3) {
    return NextResponse.json({ error: 'Provide 1–3 non-empty prompts' }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: requestData, error: requestError } = await supabase
    .from('audit_requests')
    .select('id, status, url')
    .eq('id', auditId)
    .maybeSingle();

  if (requestError || !requestData) {
    return NextResponse.json({ error: 'Audit not found' }, { status: 404 });
  }

  if (requestData.status !== 'complete') {
    return NextResponse.json({ error: 'Audit is not complete' }, { status: 400 });
  }

  const { data: resultData, error: resultError } = await supabase
    .from('audit_results')
    .select('raw_findings')
    .eq('audit_request_id', auditId)
    .maybeSingle();

  if (resultError || !resultData) {
    return NextResponse.json({ error: 'Audit results not found' }, { status: 404 });
  }

  const raw = (resultData.raw_findings ?? {}) as Record<string, unknown>;

  // Already run: return the stored results without spending again.
  if (raw.customProbe) {
    return NextResponse.json({ customProbe: raw.customProbe });
  }

  // Custom prompts are part of the unlocked report: an unlock writes a lead for this audit.
  const { count: leadCount, error: leadError } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('audit_request_id', auditId);

  if (leadError) {
    console.error('[custom-prompts] unlock lookup failed:', JSON.stringify(leadError));
    return NextResponse.json({ error: 'Try again later' }, { status: 503 });
  }
  if (!leadCount) {
    return NextResponse.json({ error: 'Unlock the report first' }, { status: 403 });
  }

  try {
    const reserve = { reserveFirst: true };
    const perIp = await checkRateLimit(
      `custom:${getClientIp(request)}`,
      CUSTOM_PROMPTS_PER_IP,
      reserve,
    );
    const perAudit = perIp.limited
      ? perIp
      : await checkRateLimit(`custom-audit:${auditId}`, CUSTOM_PROMPTS_PER_AUDIT, reserve);
    const allVisitors = perIp.limited || perAudit.limited
      ? perAudit
      : await checkRateLimit('custom-global', globalMax(), reserve);
    if (perIp.limited || perAudit.limited || allVisitors.limited) {
      return NextResponse.json(
        { error: 'Too many custom prompt runs. Try again later.', retryAfterSeconds: 3600 },
        { status: 429, headers: { 'Retry-After': '3600' } },
      );
    }
  } catch (err) {
    // Fail closed: an unchecked run spends real money.
    console.error('[custom-prompts] rate limit check failed; refusing the request:', err);
    return NextResponse.json({ error: 'Try again later' }, { status: 503 });
  }

  const domain = requestData.url as string;
  const companyName = domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('.')[0];

  const [claude, openai, perplexity, google] = await Promise.all([
    probeWithPrompts(domain, companyName, validPrompts).catch(() => null),
    probeOpenAI(domain, companyName, validPrompts).catch(() => null),
    probePerplexity(domain, companyName, validPrompts).catch(() => null),
    probeGoogleAI(domain, companyName, validPrompts).catch(() => null),
  ]);

  const customProbe = { claude, openai, perplexity, google, prompts: validPrompts };

  await supabase
    .from('audit_results')
    .update({
      raw_findings: { ...raw, customProbe },
      updated_at: new Date().toISOString(),
    })
    .eq('audit_request_id', auditId);

  return NextResponse.json({ customProbe });
}
