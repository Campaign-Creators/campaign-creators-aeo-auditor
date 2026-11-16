import { createClient } from '@supabase/supabase-js';
import { startOfUtcDay } from '@/lib/gate';

/**
 * A daily ceiling on paid AI-engine calls from all visitors together, on top of the
 * per-visitor and per-audit limits. Every path that spends reserves its calls here first.
 * The ceiling is AEO_DAILY_AI_CALL_CAP (calls per UTC day); unset or unusable means the
 * default. It fails closed: if the reservation can't be written or counted, nothing runs.
 */

/** Worst case for one audit: one call to write the questions, then four engines × ten. */
export const AUDIT_AI_CALLS = 41;

/** About 48 full audits a day. Changing it is a cost decision. */
export const DEFAULT_DAILY_AI_CALLS = 2000;

/** Rows in the shared limiter table, one per call, under this key. */
const KEY = 'ai-calls';

export type AiBudgetRefusal = { status: number; body: { error: string; code: string } };

const REFUSAL: AiBudgetRefusal = {
  status: 503,
  body: { error: 'Free audits have reached their limit for today. Please try again tomorrow.', code: 'AI_DAILY_LIMIT' },
};

export function dailyAiCallCap(): number {
  const raw = (process.env.AEO_DAILY_AI_CALL_CAP ?? '').trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : 0;
  return n > 0 ? n : DEFAULT_DAILY_AI_CALLS;
}

/**
 * Reserve `calls` paid calls for today, then count. Recording first means requests that
 * arrive together can't all see a count taken before any was recorded; the price is that
 * a refused request still uses its share, which only matters once the day is spent anyway.
 * Returns null when the calls may go ahead, or the refusal to send.
 */
export async function reserveAiCalls(calls: number): Promise<AiBudgetRefusal | null> {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const now = new Date().toISOString();
    const rows = Array.from({ length: Math.max(1, calls) }, () => ({ ip: KEY, created_at: now }));
    const { error: insertError } = await supabase.from('audit_rate_limits').insert(rows);
    if (insertError) throw insertError;

    const { count, error: countError } = await supabase
      .from('audit_rate_limits')
      .select('*', { count: 'exact', head: true })
      .eq('ip', KEY)
      .gte('created_at', startOfUtcDay());
    if (countError) throw countError;

    if ((count ?? 0) > dailyAiCallCap()) {
      console.log('[ai-budget] daily limit reached');
      return REFUSAL;
    }
    return null;
  } catch (err) {
    console.error('[ai-budget] reservation failed; refusing:', err);
    return REFUSAL;
  }
}
