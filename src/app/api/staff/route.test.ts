import { describe, it, expect, vi } from 'vitest';

const { staffMock } = vi.hoisted(() => ({ staffMock: vi.fn(async (): Promise<string | null> => null) }));
vi.mock('@/lib/staff', () => ({ staffEmail: staffMock }));

import { GET } from './route';

async function ask() {
  const { NextRequest } = await import('next/server');
  return (await GET(new NextRequest('http://localhost:3000/api/staff'))).json();
}

describe('GET /api/staff', () => {
  it('answers yes or no and never returns the email', async () => {
    expect(await ask()).toEqual({ staff: false });
    staffMock.mockResolvedValueOnce('staff@example.com');
    const body = await ask();
    expect(body).toEqual({ staff: true });
    expect(JSON.stringify(body)).not.toContain('@');
  });
});
