import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function getSupabase(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

const WINDOW_SECONDS = 3600;

/**
 * Read the caller's IP from the proxy headers Vercel sets.
 *
 * Shared so that every rate-limited route buckets callers the same way; it used to be
 * copied into whichever route happened to need it.
 */
export function getClientIp(request: { headers: Headers }): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  return '127.0.0.1';
}

/**
 * Count-and-insert rate limiter over a one-hour window.
 *
 * `key` is stored as-is, so callers that want their own budget prefix it — `unlock:1.2.3.4`
 * counts separately from `1.2.3.4`. That keeps a visitor's audit allowance and their unlock
 * allowance from draining each other, and it needs no schema change to a production table.
 */
export async function checkRateLimit(
  key: string,
  limit = Number.parseInt(process.env.RATE_LIMIT_MAX ?? '5', 10) || 5,
): Promise<{ limited: boolean }> {
  const supabase = getSupabase();
  const since = new Date(Date.now() - WINDOW_SECONDS * 1000).toISOString();

  const { count, error: countError } = await supabase
    .from('audit_rate_limits')
    .select('*', { count: 'exact', head: true })
    .eq('ip', key)
    .gte('created_at', since);

  if (countError) {
    console.error('RATE_LIMIT_ERROR:', JSON.stringify(countError));
    throw countError;
  }

  if ((count ?? 0) >= limit) {
    return { limited: true };
  }

  const { error: insertError } = await supabase
    .from('audit_rate_limits')
    .insert({ ip: key, created_at: new Date().toISOString() });

  if (insertError) {
    console.error('RATE_INSERT_ERROR:', JSON.stringify(insertError));
    throw insertError;
  }

  return { limited: false };
}
