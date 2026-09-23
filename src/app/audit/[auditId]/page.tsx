import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import AuditResultPage from '@/components/aeo/AuditResultPage';
import AuditProgress from '@/components/aeo/AuditProgress';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

type PageProps = { params: Promise<{ auditId: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { auditId } = await params;
  const supabase = getSupabase();
  const { data } = await (supabase as any)
    .from('audit_requests')
    .select('url')
    .eq('id', auditId)
    .maybeSingle();
  const domain = data?.url
    ? (() => { try { return new URL(data.url).hostname; } catch { return data.url; } })()
    : 'AEO Report';
  return { title: `AEO Report — ${domain} | Campaign Creators` };
}

export default async function AuditResultRoute({ params }: PageProps) {
  const { auditId } = await params;

  const supabase = getSupabase();

  const { data: requestRaw } = await supabase
    .from('audit_requests')
    .select('id, url, status, created_at')
    .eq('id', auditId)
    .maybeSingle();

  if (!requestRaw) {
    return (
      <div style={{ textAlign: 'center', padding: '6rem 1rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#374151' }}>
          Audit not found
        </h2>
        <p style={{ color: '#6b7280', marginTop: '0.5rem' }}>
          The audit ID you provided doesn&apos;t exist or has expired.
        </p>
      </div>
    );
  }

  const requestData = requestRaw as any;

  if (requestData.status === 'pending' || requestData.status === 'processing') {
    const domain = (() => {
      try { return new URL(requestData.url).hostname; } catch { return requestData.url; }
    })();
    return <AuditProgress domain={domain} auditId={auditId} />;
  }

  if (requestData.status === 'failed') {
    return (
      <div style={{ textAlign: 'center', padding: '6rem 1rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#374151' }}>
          Audit failed
        </h2>
        <p style={{ color: '#6b7280', marginTop: '0.5rem' }}>
          Something went wrong analysing this domain. Please try again.
        </p>
        <a href="/" style={{ marginTop: '1.5rem', display: 'inline-block', padding: '0.6rem 1.2rem', background: '#1d4ed8', color: '#fff', borderRadius: 8, textDecoration: 'none', fontWeight: 600 }}>
          Run a new audit
        </a>
      </div>
    );
  }

  const { data: resultRaw } = await supabase
    .from('audit_results')
    .select(
      'id, audit_request_id, overall_score, overall_grade, answerability_score, answerability_grade, brevity_score, brevity_grade, trust_score, trust_grade, structure_score, structure_grade, freshness_score, freshness_grade, raw_findings, created_at',
    )
    .eq('audit_request_id', auditId)
    .maybeSingle();

  if (!resultRaw) {
    return (
      <div style={{ textAlign: 'center', padding: '6rem 1rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#374151' }}>
          Results not ready yet
        </h2>
        <p style={{ color: '#6b7280', marginTop: '0.5rem' }}>
          The audit completed but results are still being processed. Please refresh in a moment.
        </p>
      </div>
    );
  }

  return (
    <AuditResultPage
      requestData={requestData}
      auditData={resultRaw as any}
    />
  );
}
