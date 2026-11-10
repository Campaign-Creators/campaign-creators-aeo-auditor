import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runGate, startOfUtcDay, gateMode } from './gate';

const KEYS = [
  'AEO_GATE_MODE', 'AEO_AUDITS_PAUSED', 'AEO_PREVIEW_DB_ISOLATED', 'AEO_PUBLIC_ACCESS', 'AEO_DAILY_AUDIT_CAP',
  'VERCEL_ENV', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY',
  'INNGEST_EVENT_KEY', 'INTERNAL_CRAWLER_SECRET', 'AEO_UNLOCK_COOKIE_SECRET',
];

let log: ReturnType<typeof vi.spyOn>;
const logged = () => log.mock.calls.flat().join(' ');

function healthy(mode: string) {
  Object.assign(process.env, {
    AEO_GATE_MODE: mode, VERCEL_ENV: 'production', AEO_DAILY_AUDIT_CAP: '50',
    NEXT_PUBLIC_SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'a', INNGEST_EVENT_KEY: 'i',
    AEO_UNLOCK_COOKIE_SECRET: 'c',
  });
}

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); for (const k of KEYS) delete process.env[k]; });

describe('gate mode', () => {
  it('unset or unknown is off', () => {
    expect(gateMode()).toBe('off');
    process.env.AEO_GATE_MODE = 'on';
    expect(gateMode()).toBe('off');
  });
});

describe('run gate', () => {
  it('off evaluates nothing but the pause switch', async () => {
    const count = vi.fn(async () => 9999);
    expect(await runGate(count)).toBeNull();
    expect(count).not.toHaveBeenCalled();
  });

  it('rule 1: paused refuses in every mode', async () => {
    process.env.AEO_AUDITS_PAUSED = 'true';
    expect((await runGate(async () => 0))?.body.code).toBe('PAUSED');
    healthy('observe');
    expect((await runGate(async () => 0))?.status).toBe(503);
  });

  it('rule 2: missing config', async () => {
    healthy('enforce');
    delete process.env.ANTHROPIC_API_KEY;
    expect((await runGate(async () => 0))?.body.code).toBe('CONFIG_MISSING');
  });

  it('rule 2: no unlock cookie key counts as missing config', async () => {
    healthy('enforce');
    delete process.env.AEO_UNLOCK_COOKIE_SECRET;
    expect((await runGate(async () => 0))?.body.code).toBe('CONFIG_MISSING');
  });

  it('rule 2: the crawler fallback counts in place of the queue key', async () => {
    healthy('enforce');
    delete process.env.INNGEST_EVENT_KEY;
    process.env.INTERNAL_CRAWLER_SECRET = 'c';
    expect(await runGate(async () => 0)).toBeNull();
  });

  it('rule 3: a preview build on the shared database is refused', async () => {
    healthy('enforce');
    process.env.VERCEL_ENV = 'preview';
    const r = await runGate(async () => 0);
    expect(r?.status).toBe(403);
    expect(r?.body.code).toBe('PREVIEW_SHARED_DB');
    process.env.AEO_PREVIEW_DB_ISOLATED = 'true';
    expect(await runGate(async () => 0)).toBeNull();
  });

  it('rule 5: staff only refuses public callers', async () => {
    healthy('enforce');
    process.env.AEO_PUBLIC_ACCESS = 'staff_only';
    expect((await runGate(async () => 0))?.body.code).toBe('STAFF_ONLY');
  });

  it('rule 6: the daily cap refuses at the cap, not below it', async () => {
    healthy('enforce');
    expect(await runGate(async () => 49)).toBeNull();
    const r = await runGate(async () => 50);
    expect(r?.status).toBe(503);
    expect(r?.body.code).toBe('DAILY_CAP');
    expect(logged()).toContain('[gate] enforce refuse DAILY_CAP');
  });

  it('rule 6: enforce without a cap fails closed', async () => {
    healthy('enforce');
    delete process.env.AEO_DAILY_AUDIT_CAP;
    expect((await runGate(async () => 0))?.body.code).toBe('CONFIG_MISSING');
  });

  it('rule 6: enforce fails closed when the count cannot be read', async () => {
    healthy('enforce');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await runGate(async () => { throw new Error('db down'); }))?.body.code).toBe('CONFIG_MISSING');
    err.mockRestore();
  });

  it('observe without a cap logs today\'s count, not a config refusal', async () => {
    healthy('observe');
    delete process.env.AEO_DAILY_AUDIT_CAP;
    expect(await runGate(async () => 7)).toBeNull();
    expect(logged()).toContain('[gate] observe count 7');
    expect(logged()).not.toContain('CONFIG_MISSING');
  });

  it('observe with a cap also logs the count', async () => {
    healthy('observe');
    await runGate(async () => 12);
    expect(logged()).toContain('[gate] observe count 12');
  });

  it('staff skip the daily cap and staff_only (AC-019); pause still applies', async () => {
    healthy('enforce');
    expect(await runGate(async () => 50, { staff: true })).toBeNull();
    process.env.AEO_PUBLIC_ACCESS = 'staff_only';
    expect(await runGate(async () => 0, { staff: true })).toBeNull();
    process.env.AEO_AUDITS_PAUSED = 'true';
    expect((await runGate(async () => 0, { staff: true }))?.body.code).toBe('PAUSED');
  });

  it('observe logs what it would refuse and refuses nothing', async () => {
    healthy('observe');
    expect(await runGate(async () => 50)).toBeNull();
    expect(logged()).toContain('[gate] observe would-refuse DAILY_CAP');
  });

  it('the day starts at midnight UTC', () => {
    expect(startOfUtcDay(new Date('2026-11-10T23:59:00-08:00'))).toBe('2026-11-11T00:00:00.000Z');
  });
});
