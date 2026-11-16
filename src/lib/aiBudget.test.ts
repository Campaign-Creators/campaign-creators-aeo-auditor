import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { db } = vi.hoisted(() => ({
  db: { rows: [] as Array<{ ip: string; created_at: string }>, failInsert: false, failCount: false },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      insert: async (rows: Array<{ ip: string; created_at: string }> | { ip: string; created_at: string }) => {
        if (db.failInsert) return { error: { message: 'down' } };
        db.rows.push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      },
      select: () => ({
        eq: (_c: string, key: string) => ({
          gte: async (_c2: string, since: string) => db.failCount
            ? { count: null, error: { message: 'down' } }
            : { count: db.rows.filter(r => r.ip === key && r.created_at >= since).length, error: null },
        }),
      }),
    }),
  }),
}));

beforeEach(() => {
  vi.resetModules();
  db.rows = [];
  db.failInsert = false;
  db.failCount = false;
  delete process.env.AEO_DAILY_AI_CALL_CAP;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.AEO_DAILY_AI_CALL_CAP; });

describe('daily ceiling on paid AI-engine calls, all visitors together', () => {
  it('allows calls up to the ceiling and refuses past it, with a plain message', async () => {
    process.env.AEO_DAILY_AI_CALL_CAP = '100';
    const { reserveAiCalls } = await import('./aiBudget');
    expect(await reserveAiCalls(41)).toBeNull();
    expect(await reserveAiCalls(41)).toBeNull();
    const refused = await reserveAiCalls(41);
    expect(refused?.status).toBe(503);
    expect(refused?.body.code).toBe('AI_DAILY_LIMIT');
    expect(refused?.body.error).toMatch(/today/i);
    expect(refused?.body.error).not.toMatch(/AI_|cap|budget/i);
  });

  it('a request that fits exactly is allowed', async () => {
    process.env.AEO_DAILY_AI_CALL_CAP = '12';
    const { reserveAiCalls } = await import('./aiBudget');
    expect(await reserveAiCalls(12)).toBeNull();
    expect(await reserveAiCalls(1)).not.toBeNull();
  });

  it('counts only today (UTC)', async () => {
    process.env.AEO_DAILY_AI_CALL_CAP = '10';
    const { reserveAiCalls } = await import('./aiBudget');
    db.rows.push(...Array.from({ length: 10 }, () => ({ ip: 'ai-calls', created_at: '2020-01-01T00:00:00.000Z' })));
    expect(await reserveAiCalls(10)).toBeNull();
  });

  it('has a default ceiling when none is set, and ignores unusable values', async () => {
    const { dailyAiCallCap, DEFAULT_DAILY_AI_CALLS } = await import('./aiBudget');
    expect(dailyAiCallCap()).toBe(DEFAULT_DAILY_AI_CALLS);
    expect(DEFAULT_DAILY_AI_CALLS).toBeGreaterThan(0);
    for (const v of ['0', '-5', 'abc', '1e3', '1.5', '']) {
      process.env.AEO_DAILY_AI_CALL_CAP = v;
      expect(dailyAiCallCap()).toBe(DEFAULT_DAILY_AI_CALLS);
    }
    process.env.AEO_DAILY_AI_CALL_CAP = '250';
    expect(dailyAiCallCap()).toBe(250);
  });

  it('fails closed when the reservation cannot be written', async () => {
    db.failInsert = true;
    const { reserveAiCalls } = await import('./aiBudget');
    expect((await reserveAiCalls(1))?.status).toBe(503);
  });

  it('fails closed when the count cannot be read', async () => {
    db.failCount = true;
    const { reserveAiCalls } = await import('./aiBudget');
    expect((await reserveAiCalls(1))?.status).toBe(503);
  });

  it('a whole audit is costed at its worst case', async () => {
    const { AUDIT_AI_CALLS } = await import('./aiBudget');
    // One call to write the questions, then four engines × ten questions.
    expect(AUDIT_AI_CALLS).toBe(41);
  });
});
