// npm run gate:check — which gate settings this shell has. Names and present/absent only,
// never a value. With the Supabase URL and service key present it also prints today's
// audit count (a number, not a secret).

import { pathToFileURL } from 'node:url';

const NAMES = [
  'AEO_GATE_MODE', 'AEO_AUDITS_PAUSED', 'AEO_PREVIEW_DB_ISOLATED', 'AEO_PUBLIC_ACCESS',
  'AEO_DAILY_AUDIT_CAP', 'AEO_UNLOCK_COOKIE_SECRET', 'AEO_STAFF_EMAILS', 'AEO_HUBSPOT_SYNC',
  'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY',
  'INNGEST_EVENT_KEY', 'INTERNAL_CRAWLER_SECRET', 'HUBSPOT_PRIVATE_APP_TOKEN', 'VERCEL_ENV',
];

export function report(env) {
  const m = String(env.AEO_GATE_MODE ?? '').trim().toLowerCase();
  const mode = m === 'observe' || m === 'enforce' ? m : 'off';
  const width = Math.max(...NAMES.map(n => n.length));
  const lines = NAMES.map(n => `${n.padEnd(width)}  ${String(env[n] ?? '').trim() ? 'present' : 'absent'}`);
  return [`mode: ${mode}`, ...lines].join('\n');
}

async function todaysCount(env) {
  const { createClient } = await import('@supabase/supabase-js');
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const { count, error } = await createClient(env.NEXT_PUBLIC_SUPABASE_URL.trim(), env.SUPABASE_SERVICE_ROLE_KEY.trim())
    .from('audit_requests').select('id', { count: 'exact', head: true }).gte('created_at', since);
  return error ? 'unavailable (database error)' : String(count ?? 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(report(process.env));
  if (process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    console.log(`audits today (UTC): ${await todaysCount(process.env)}`);
  }
}
