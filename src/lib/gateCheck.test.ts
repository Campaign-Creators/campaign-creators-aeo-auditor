import { describe, it, expect } from 'vitest';
import { report } from '../../scripts/gate-check.mjs';

describe('npm run gate:check', () => {
  it('prints each name as present or absent and the mode, never a value', () => {
    const out: string = report({
      AEO_GATE_MODE: 'observe',
      AEO_UNLOCK_COOKIE_SECRET: 'super-private-value',
      AEO_DAILY_AUDIT_CAP: '50',
    });
    expect(out).toContain('mode: observe');
    expect(out).toMatch(/AEO_UNLOCK_COOKIE_SECRET\s+present/);
    expect(out).toMatch(/AEO_STAFF_EMAILS\s+absent/);
    expect(out).toMatch(/AEO_DAILY_AUDIT_CAP\s+present/);
    expect(out).not.toContain('super-private-value');
    expect(out).not.toContain('50');
  });

  it('prints the report gate on its own line: enforce unless off or observe', () => {
    expect(report({})).toContain('report gate: enforce');
    expect(report({ AEO_REPORT_GATE: 'off' })).toContain('report gate: off');
    expect(report({ AEO_REPORT_GATE: 'nonsense' })).toContain('report gate: enforce');
    expect(report({ AEO_REPORT_GATE: 'off' })).toMatch(/AEO_REPORT_GATE\s+present/);
  });

  it('an unset or unknown mode reads as off', () => {
    expect(report({})).toContain('mode: off');
    expect(report({ AEO_GATE_MODE: 'on' })).toContain('mode: off');
  });
});
