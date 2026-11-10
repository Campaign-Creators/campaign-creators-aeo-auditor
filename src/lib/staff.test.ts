// FR-014: a caller is staff only when a verified sign-in token belongs to an email on
// AEO_STAFF_EMAILS. Anything missing or unverifiable means public.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { staffEmail, staffList } from './staff';

const req = (auth?: string) => ({ headers: new Headers(auth ? { authorization: auth } : {}) });

afterEach(() => { delete process.env.AEO_STAFF_EMAILS; });

describe('staff list', () => {
  it('is empty when unset, and normalised when set', () => {
    expect(staffList()).toEqual([]);
    process.env.AEO_STAFF_EMAILS = ' Staff@Example.com , , other@example.com ';
    expect(staffList()).toEqual(['staff@example.com', 'other@example.com']);
  });
});

describe('staffEmail', () => {
  it('no list: nobody is staff, and the token is not even checked', async () => {
    const verify = vi.fn(async () => 'staff@example.com');
    expect(await staffEmail(req('Bearer t'), verify)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('a verified token for a listed email is staff', async () => {
    process.env.AEO_STAFF_EMAILS = 'staff@example.com';
    expect(await staffEmail(req('Bearer good'), async () => 'Staff@Example.com')).toBe('staff@example.com');
  });

  it('a verified token for an unlisted email is public', async () => {
    process.env.AEO_STAFF_EMAILS = 'staff@example.com';
    expect(await staffEmail(req('Bearer good'), async () => 'visitor@example.com')).toBeNull();
  });

  it('no token, a malformed header, or a token that fails to verify is public', async () => {
    process.env.AEO_STAFF_EMAILS = 'staff@example.com';
    const ok = async () => 'staff@example.com';
    expect(await staffEmail(req(), ok)).toBeNull();
    expect(await staffEmail(req('Basic abc'), ok)).toBeNull();
    expect(await staffEmail(req('Bearer '), ok)).toBeNull();
    expect(await staffEmail(req('Bearer bad'), async () => null)).toBeNull();
    expect(await staffEmail(req('Bearer err'), async () => { throw new Error('auth down'); })).toBeNull();
  });
});
