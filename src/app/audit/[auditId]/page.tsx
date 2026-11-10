import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { reportAccess, redactForPreview, unlockCookieName } from '@/lib/gate';
import AuditResultPage from '@/components/aeo/AuditResultPage';
import AuditProgress from '@/components/aeo/AuditProgress';
import styles from './page.module.css';

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

function StateMessage({ title, action, children }: { title: string; action?: boolean; children: React.ReactNode }) {
  return (
    <div className={styles.state} role="status">
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.text}>{children}</p>
      {action && <Link href="/" className={`btn btn-primary ${styles.action}`}>Run a new audit</Link>}
    </div>
  );
}

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
      <StateMessage title="Audit not found" action>
        The audit ID you provided doesn&apos;t exist or has expired.
      </StateMessage>
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
      <StateMessage title="Audit failed" action>
        Something went wrong analysing this domain. Please try again.
      </StateMessage>
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
      <StateMessage title="Results not ready yet">
        The audit completed but results are still being processed. Please refresh in a moment.
      </StateMessage>
    );
  }

  const cookie = (await cookies()).get(unlockCookieName(auditId))?.value;
  const locked = reportAccess(auditId, cookie) === 'preview';

  return (
    <AuditResultPage
      // Remount when access changes so state seeded from props (custom results) refreshes.
      key={locked ? 'preview' : 'full'}
      requestData={requestData}
      auditData={(locked ? redactForPreview(resultRaw) : resultRaw) as any}
      locked={locked}
    />
  );
}
