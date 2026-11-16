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

/**
 * One row per reservation in the shared limiter table, its size in the key
 * (`ai-calls:<n>`), so the table grows by reservations, not by calls.
 */
const PREFIX = 'ai-calls:';

/** Rows read per count. More reservations than this in a day fails closed. */
export const MAX_ROWS_READ = 1000;

export type AiBudgetRefusal = { status: number; body: { error: string; code: string } };

const REFUSAL: AiBudgetRefusal = {
  status: 503,
  body: { error: 'Free audits have reached their limit for today. Please try again later.', code: 'AI_DAILY_LIMIT' },
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
 * Staff are recorded, so the count stays true, but never refused.
 * Returns null when the calls may go ahead, or the refusal to send.
 */
export async function reserveAiCalls(
  calls: number,
  { staff = false }: { staff?: boolean } = {},
): Promise<AiBudgetRefusal | null> {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const size = Math.min(AUDIT_AI_CALLS, Math.max(1, Math.floor(calls)));
    const { error: insertError } = await supabase
      .from('audit_rate_limits')
      .insert({ ip: `${PREFIX}${size}`, created_at: new Date().toISOString() });
    if (insertError) throw insertError;
    if (staff) return null;

    const { data, error: countError } = await supabase
      .from('audit_rate_limits')
      .select('ip')
      .like('ip', `${PREFIX}%`)
      .gte('created_at', startOfUtcDay())
      .limit(MAX_ROWS_READ);
    if (countError) throw countError;
    const rows = (data ?? []) as Array<{ ip: string }>;
    if (rows.length >= MAX_ROWS_READ) throw new Error('too many reservations to count');

    // No real reservation is larger than an audit, so no row counts for more.
    const size_ = (r: { ip: string }) => Math.min(AUDIT_AI_CALLS, Math.max(0, Number(r.ip.slice(PREFIX.length)) || 0));
    const spent = rows.reduce((sum, r) => sum + size_(r), 0);
    if (spent > dailyAiCallCap()) {
      console.log('[ai-budget] daily limit reached');
      return REFUSAL;
    }
    return null;
  } catch (err) {
    console.error('[ai-budget] reservation failed; refusing:', err);
    return REFUSAL;
  }
}
