import { NextResponse, type NextRequest } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { inngest } from '@/lib/inngest/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let supabase: SupabaseClient | undefined;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    );
  }
  return supabase;
}

const startSchema = z.object({
  url: z
    .string()
    .url()
    .refine(
      (v) => {
        try {
          const u = new URL(v);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch (outerErr) { console.error("OUTER_ERROR:", outerErr);
          return false;
        }
      },
      { message: 'URL must use http or https protocol' },
    ),
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
  utm_content: z.string().optional(),
  utm_term: z.string().optional(),
});

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function isPrivateOrIP(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') {
    return true;
  }

  if (h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }

  // Block all IPv6 (including bracketed literals)
  if (hostname.startsWith('[') || h.includes(':')) {
    return true;
  }

  // Block IPv4 literals: loopback and RFC1918 private ranges
  if (IPV4_RE.test(h)) {
    const parts = h.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // Catch-all: refuse raw IPv4 literals — public IPs should be reached via hostname.
    return true;
  }

  // Reject purely numeric octet-style hostnames
  if (/^\d+(\.\d+)*$/.test(h)) {
    return true;
  }

  // Reject hostnames without a TLD (no dots, e.g. "intranet")
  if (!h.includes('.')) {
    return true;
  }

  return false;
}

function normalizeUrl(input: string): string {
  const u = new URL(input);
  return `https://${u.hostname}`;
}

export async function POST(request: NextRequest): Promise<Response> {
  const ip = getClientIp(request);

  try {
    try {
      const { limited } = await checkRateLimit(ip);
      if (limited) {
        return NextResponse.json(
          { error: 'Rate limit exceeded', retryAfterSeconds: 3600 },
          { status: 429, headers: { 'Retry-After': '3600' } },
        );
      }
    } catch (outerErr) { console.error("OUTER_ERROR:", outerErr);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch (outerErr) { console.error("OUTER_ERROR:", outerErr);
      return NextResponse.json(
        { error: 'Body must be valid JSON.' },
        { status: 400 },
      );
    }

    const parsed = startSchema.safeParse(body);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message).join('; ');
      return NextResponse.json({ error: messages }, { status: 400 });
    }

    let hostname: string;
    try {
      hostname = new URL(parsed.data.url).hostname;
    } catch (outerErr) { console.error("OUTER_ERROR:", outerErr);
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }

    if (isPrivateOrIP(hostname)) {
      return NextResponse.json(
        { error: 'Invalid URL: private/local addresses are not permitted' },
        { status: 400 },
      );
    }

    const normalizedUrl = normalizeUrl(parsed.data.url);

    let auditId: string;
    try {
      const { data, error } = await getSupabase()
        .from('audit_requests')
        .insert({
          url: normalizedUrl,
          status: 'pending',
          ip_address: ip,
          created_at: new Date().toISOString(),
          utm_source: parsed.data.utm_source || null,
          utm_medium: parsed.data.utm_medium || null,
          utm_campaign: parsed.data.utm_campaign || null,
          utm_content: parsed.data.utm_content || null,
          utm_term: parsed.data.utm_term || null,
        })
        .select('id')
        .single();

      if (error || !data) { console.error("AUDIT_INSERT_ERROR:", JSON.stringify(error));
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
      auditId = data.id as string;
    } catch (outerErr) { console.error("OUTER_ERROR:", outerErr);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    // Try Inngest first; fall back to the direct crawl route if it fails.
    let inngestSent = false;
    try {
      await inngest.send({
        name: 'audit/requested',
        data: { auditId, domainUrl: normalizedUrl },
      });
      inngestSent = true;
    } catch (err) {
      console.error('Inngest send failed, falling back to direct crawl:', err);
    }

    if (!inngestSent) {
      void fetch(
        new URL(
          '/api/audit/crawl',
          process.env.NEXT_PUBLIC_APP_URL!.trim(),
        ).toString(),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + process.env.INTERNAL_CRAWLER_SECRET!.trim(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ auditId, domainUrl: normalizedUrl }),
        },
      ).catch(() => {
        // Fire-and-forget; crawler logs its own failures.
      });
    }

    return NextResponse.json({ auditId }, { status: 201 });
  } catch (outerErr) { console.error("OUTER_ERROR:", outerErr);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
