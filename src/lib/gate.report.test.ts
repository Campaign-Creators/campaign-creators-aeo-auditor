import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reportAccess, reportGateMode, unlockRefusal, unlockToken } from './gate';

const KEYS = ['AEO_GATE_MODE', 'AEO_REPORT_GATE', 'AEO_UNLOCK_COOKIE_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'];

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); for (const k of KEYS) delete process.env[k]; });

describe('report gate: on by default, separate from the run gate', () => {
  it('is enforce with nothing set, even when the run gate is off', () => {
    expect(reportGateMode()).toBe('enforce');
    expect(reportAccess('audit-1', undefined)).toBe('preview');
  });

  it('can be switched off or to observe on its own', () => {
    process.env.AEO_REPORT_GATE = 'off';
    expect(reportAccess('audit-1', undefined)).toBe('full');
    process.env.AEO_REPORT_GATE = 'observe';
    expect(reportAccess('audit-1', undefined)).toBe('full');
    expect(log.mock.calls.flat().join(' ')).toContain('[gate] observe would-refuse REPORT_LOCKED');
  });

  it('an unknown value stays enforce (fails closed)', () => {
    process.env.AEO_REPORT_GATE = 'disabled';
    expect(reportGateMode()).toBe('enforce');
  });

  it('a valid proof opens the report', () => {
    expect(reportAccess('audit-1', unlockToken('audit-1')!)).toBe('full');
  });

  it('a proof for another audit does not', () => {
    expect(reportAccess('audit-2', unlockToken('audit-1')!)).toBe('preview');
  });
});

describe('unlock proof key', () => {
  it('works without a dedicated key, from the server key', () => {
    expect(unlockToken('audit-1')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('a dedicated key, when set, gives a different proof', () => {
    const derived = unlockToken('audit-1');
    process.env.AEO_UNLOCK_COOKIE_SECRET = 'dedicated';
    expect(unlockToken('audit-1')).not.toBe(derived);
  });

  it('the proof is not the server key or a plain hash of it', () => {
    const t = unlockToken('audit-1')!;
    expect(t).not.toContain('service-role-key');
  });

  it('no key at all gives no proof, so the report stays locked', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(unlockToken('audit-1')).toBeNull();
    expect(reportAccess('audit-1', 'anything')).toBe('preview');
  });
});

describe('unlock readiness follows the report gate', () => {
  it('refuses an unfinished audit with nothing set', () => {
    expect(unlockRefusal('audit-1', 'pending', false)?.status).toBe(409);
    expect(unlockRefusal('audit-1', 'complete', false)?.status).toBe(409);
    expect(unlockRefusal('audit-1', 'complete', true)).toBeNull();
  });
});
