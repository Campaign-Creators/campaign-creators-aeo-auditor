import { NextResponse, type NextRequest } from 'next/server';
import { staffEmail } from '@/lib/staff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET: is this browser's sign-in on the staff list? Only a yes/no, never the list. */
export async function GET(request: NextRequest): Promise<Response> {
  return NextResponse.json({ staff: (await staffEmail(request)) !== null });
}
