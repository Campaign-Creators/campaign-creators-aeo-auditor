import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Access and run gate. Ships dark: AEO_GATE_MODE unset (or anything unknown) is `off`,
 * which keeps today's behaviour. `observe` evaluates every rule and logs what it would
 * refuse, refusing nothing; `enforce` refuses. Log lines: `[gate] <mode> <decision> <CODE>`.
 */
export type GateMode = 'off' | 'observe' | 'enforce';
type Decision = 'refuse' | 'would-refuse';

export function gateMode(): GateMode {
  const m = (process.env.AEO_GATE_MODE ?? '').trim().toLowerCase();
  return m === 'observe' || m === 'enforce' ? m : 'off';
}

function logGate(mode: GateMode, decision: Decision, code: string, ref?: string): void {
  console.log(`[gate] ${mode} ${decision} ${code}${ref ? ` ${ref}` : ''}`);
}

// ── Report access ────────────────────────────────────────────────────────────

export function unlockCookieName(auditId: string): string {
  return `aeo_unlock_${auditId}`;
}

/** The signed proof that this browser unlocked this audit; null when no secret is set. */
export function unlockToken(auditId: string): string | null {
  const secret = (process.env.AEO_UNLOCK_COOKIE_SECRET ?? '').trim();
  if (!secret) return null;
  return createHmac('sha256', secret).update(`unlock:${auditId}`).digest('base64url');
}

function hasUnlockProof(auditId: string, value: string | undefined): boolean {
  const expected = unlockToken(auditId);
  if (!expected || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 'full' or 'preview' for this viewer. Only `enforce` ever returns 'preview'. */
export function reportAccess(auditId: string, cookieValue: string | undefined): 'full' | 'preview' {
  const mode = gateMode();
  if (mode === 'off' || hasUnlockProof(auditId, cookieValue)) return 'full';
  logGate(mode, mode === 'enforce' ? 'refuse' : 'would-refuse', 'REPORT_LOCKED', auditId);
  return mode === 'enforce' ? 'preview' : 'full';
}

type Probe = { citedCount?: number; totalPrompts?: number; status?: string; engine?: string; results?: Array<{ cited?: boolean }> } | null | undefined;

function redactProbe(p: Probe): Probe {
  if (!p) return p ?? null;
  return {
    engine: p.engine,
    status: p.status,
    citedCount: p.citedCount ?? 0,
    totalPrompts: p.totalPrompts ?? 0,
    // Keeps the cited count the preview shows; drops prompts, answers and named sites.
    results: (p.results ?? []).map(r => ({ prompt: '', cited: !!r.cited, snippet: null })),
  };
}

/**
 * The report fields a viewer without an unlock may receive: overall score and grade, date,
 * and the AI citation count. Everything else is blanked so the shape stays renderable.
 */
export function redactForPreview<T extends Record<string, unknown>>(audit: T): T {
  const rf = (audit.raw_findings ?? {}) as Record<string, unknown>;
  const probe = rf.aiProbe as Record<string, Probe> | Probe;
  let aiProbe: unknown = null;
  if (probe && typeof probe === 'object' && 'claude' in probe) {
    const m = probe as Record<string, Probe>;
    aiProbe = {
      claude: redactProbe(m.claude), openai: redactProbe(m.openai),
      perplexity: redactProbe(m.perplexity), google: redactProbe(m.google), prompts: [],
    };
  } else if (probe) {
    aiProbe = redactProbe(probe as Probe);
  }
  const out: Record<string, unknown> = {
    id: audit.id,
    audit_request_id: audit.audit_request_id,
    overall_score: audit.overall_score,
    overall_grade: audit.overall_grade,
    created_at: audit.created_at,
    raw_findings: { aiProbeStatus: rf.aiProbeStatus, aiProbe },
  };
  for (const d of ['answerability', 'brevity', 'trust', 'structure', 'freshness']) {
    out[`${d}_score`] = 0;
    out[`${d}_grade`] = '';
  }
  return out as T;
}

// ── Unlock ───────────────────────────────────────────────────────────────────

/** An unlock is accepted only for a finished audit with results. Returns a refusal or null. */
export function unlockRefusal(auditId: string, status: string | undefined, hasResult: boolean):
  { status: number; body: { error: string; code: string } } | null {
  const mode = gateMode();
  if (mode === 'off' || (status === 'complete' && hasResult)) return null;
  logGate(mode, mode === 'enforce' ? 'refuse' : 'would-refuse', 'UNLOCK_NOT_READY', auditId);
  return mode === 'enforce'
    ? { status: 409, body: { error: 'This report is not ready yet.', code: 'UNLOCK_NOT_READY' } }
    : null;
}

// ── Run gate (POST /api/audit/start) ─────────────────────────────────────────

type Refusal = { status: number; body: { error: string; code: string } };

const PAUSED_MSG = 'Audits are paused right now. Please try again later.';

function refusal(code: string): Refusal {
  if (code === 'PREVIEW_SHARED_DB') return { status: 403, body: { error: "Audits can't run on preview builds.", code } };
  if (code === 'STAFF_ONLY') return { status: 403, body: { error: PAUSED_MSG, code } };
  return { status: 503, body: { error: PAUSED_MSG, code } };
}

function dailyCap(): number | null {
  const raw = (process.env.AEO_DAILY_AUDIT_CAP ?? '').trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

/** Midnight UTC today, for counting today's audits. */
export function startOfUtcDay(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** Rule 1 on its own, in every mode: cheap, so routes can check it before anything else. */
export function pauseRefusal(): Refusal | null {
  if ((process.env.AEO_AUDITS_PAUSED ?? '').trim() !== 'true') return null;
  logGate(gateMode(), 'refuse', 'PAUSED');
  return refusal('PAUSED');
}

/**
 * Rules in order, first failure wins. Every caller is public until staff sign-in exists.
 * `countToday` is only called when the earlier rules pass and a cap applies.
 */
export async function runGate(countToday: () => Promise<number>): Promise<Refusal | null> {
  const paused = pauseRefusal();
  if (paused) return paused;
  const mode = gateMode();
  if (mode === 'off') return null;

  const code = await firstFailingRule(countToday, mode);
  if (!code) return null;
  logGate(mode, mode === 'enforce' ? 'refuse' : 'would-refuse', code);
  return mode === 'enforce' ? refusal(code) : null;
}

async function firstFailingRule(countToday: () => Promise<number>, mode: GateMode): Promise<string | null> {
  const env = process.env;
  const has = (k: string) => !!(env[k] ?? '').trim();
  if (!has('NEXT_PUBLIC_SUPABASE_URL') || !has('SUPABASE_SERVICE_ROLE_KEY') || !has('ANTHROPIC_API_KEY')
    || !(has('INNGEST_EVENT_KEY') || has('INTERNAL_CRAWLER_SECRET'))
    // Without it no visitor can ever unlock, so enforce would show previews only.
    || !has('AEO_UNLOCK_COOKIE_SECRET')) return 'CONFIG_MISSING';
  if (env.VERCEL_ENV !== 'production' && (env.AEO_PREVIEW_DB_ISOLATED ?? '').trim() !== 'true') return 'PREVIEW_SHARED_DB';
  if ((env.AEO_PUBLIC_ACCESS ?? '').trim() === 'staff_only') return 'STAFF_ONLY';

  const cap = dailyCap();
  // Enforce without a cap fails closed. Observe logs the count instead, to help pick the cap.
  if (cap === null && mode === 'enforce') return 'CONFIG_MISSING';
  try {
    const n = await countToday();
    if (mode === 'observe') console.log(`[gate] observe count ${n}`);
    return cap !== null && n >= cap ? 'DAILY_CAP' : null;
  } catch (err) {
    console.error('[gate] daily count failed:', err);
    return mode === 'enforce' ? 'CONFIG_MISSING' : null;
  }
}

type CountClient = {
  from(t: string): { select(c: string, o: { count: 'exact'; head: true }): { gte(col: string, v: string): PromiseLike<{ count: number | null; error: unknown }> } };
};

/** Today's audits (UTC day), for the daily cap. Throws on a database error. */
export async function countTodaysAudits(supabase: CountClient): Promise<number> {
  const { count, error } = await supabase
    .from('audit_requests')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', startOfUtcDay());
  if (error) throw error;
  return count ?? 0;
}
