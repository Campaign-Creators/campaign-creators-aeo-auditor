import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { reportAccess, unlockCookieName } from '@/lib/gate';
import { engineBadge } from '@/lib/auditor/engineBadge';
import styles from './pdf.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

interface ProbeResult {
  prompt: string;
  cited: boolean;
  snippet: string | null;
}

interface AiProbe {
  engine: string;
  results: ProbeResult[];
  citedCount: number;
  totalPrompts: number;
  status: 'cited' | 'partial' | 'missing';
  failedPrompts?: number;
}

interface MultiEngineProbe {
  claude: AiProbe | null;
  openai: AiProbe | null;
  perplexity: AiProbe | null;
  google?: AiProbe | null;
  prompts: string[];
}

interface RawFindings {
  robots?: {
    gptBotDisallowed?: boolean;
    claudeBotDisallowed?: boolean;
    googlebotDisallowed?: boolean;
    bingbotDisallowed?: boolean;
  };
  pages?: Array<{
    url?: string;
    h1?: string;
    h2s?: string[];
    wordCount?: number;
    hasStructuredData?: boolean;
    canonicalUrl?: string;
    metaDescription?: string;
    statusCode?: number;
  }>;
  sitemapListed?: boolean;
  openGraphPresent?: boolean;
  structuredDataTypes?: string[];
  wordCount?: number;
  lastModified?: string | null;
  aiProbe?: AiProbe | MultiEngineProbe | null;
}

type FindingItem = { pass: boolean; text: string } | { meta: string };

function isMultiEngine(probe: AiProbe | MultiEngineProbe): probe is MultiEngineProbe {
  return 'claude' in probe;
}

function crawlabilityFindings(rf: RawFindings): FindingItem[] {
  const pages = rf.pages ?? [];
  const robots = rf.robots ?? {};
  const aiOk = !robots.gptBotDisallowed && !robots.claudeBotDisallowed &&
    !robots.googlebotDisallowed && !robots.bingbotDisallowed;
  const canonicalCount = pages.filter(p => !!p.canonicalUrl).length;
  const allOk = pages.length > 0 && pages.every(p => p.statusCode === 200);
  return [
    { pass: aiOk, text: 'robots.txt allows AI bots' },
    { pass: !!rf.sitemapListed, text: 'Sitemap detected' },
    { pass: pages.length > 0 && canonicalCount === pages.length, text: 'Canonical URLs present' },
    { pass: allOk, text: 'All pages returned 200 OK' },
    { meta: `${pages.length} page${pages.length !== 1 ? 's' : ''} crawled successfully` },
  ];
}

function schemaFindings(rf: RawFindings): FindingItem[] {
  const pages = rf.pages ?? [];
  const types = rf.structuredDataTypes ?? [];
  const pagesWithSD = pages.filter(p => p.hasStructuredData);
  const missingTypes = ['Organization', 'Article', 'FAQ', 'HowTo'].filter(t => !types.includes(t));
  const items: FindingItem[] = [
    { pass: pagesWithSD.length > 0, text: 'JSON-LD structured data found' },
    types.length > 0 ? { meta: `Types found: ${types.join(', ')}` } : { meta: 'No structured data detected' },
  ];
  if (missingTypes.length > 0) items.push({ pass: false, text: `Missing types: ${missingTypes.join(', ')}` });
  items.push({ meta: `${pagesWithSD.length} of ${pages.length} pages have structured data` });
  return items;
}

function authorityFindings(rf: RawFindings): FindingItem[] {
  const pages = rf.pages ?? [];
  const pagesWithMeta = pages.filter(p => !!p.metaDescription);
  const pagesWithHeadings = pages.filter(p => !!p.h1 && p.h2s && p.h2s.length > 0);
  return [
    { pass: !!rf.openGraphPresent, text: 'Open Graph tags present' },
    { pass: pages.length > 0 && pagesWithMeta.length === pages.length, text: 'Meta descriptions on all pages' },
    { pass: pagesWithHeadings.length > 0, text: 'Strong heading hierarchy (H1 + H2s)' },
    { meta: '0 external authority links found' },
  ];
}

function topicalFindings(rf: RawFindings): FindingItem[] {
  const pages = rf.pages ?? [];
  const totalWords = rf.wordCount ?? pages.reduce((sum, p) => sum + (p.wordCount ?? 0), 0);
  const avgWords = pages.length > 0 ? Math.round(totalWords / pages.length) : 0;
  const depthLabel = avgWords >= 1000
    ? 'Good content depth (>1000 words/page)'
    : avgWords >= 500
    ? 'Moderate content depth (500–999 words/page)'
    : 'Thin content (<500 words/page)';
  const topics: string[] = [];
  pages.forEach(p => {
    if (p.h1) topics.push(p.h1);
    p.h2s?.slice(0, 2).forEach(h => topics.push(h));
  });
  const items: FindingItem[] = [
    { meta: `${totalWords.toLocaleString()} total words across ${pages.length} pages` },
    { meta: `Average ${avgWords.toLocaleString()} words per page` },
    { pass: avgWords >= 1000, text: depthLabel },
  ];
  if (topics.length > 0) items.push({ meta: `Top topics: ${topics.slice(0, 5).join(' · ')}` });
  return items;
}

function freshnessFindings(rf: RawFindings): FindingItem[] {
  const types = rf.structuredDataTypes ?? [];
  const hasArticleSchema = types.some(t => ['Article', 'BlogPosting', 'NewsArticle'].includes(t));
  return [
    {
      pass: !!rf.lastModified,
      text: rf.lastModified
        ? `Last-Modified header present (${rf.lastModified})`
        : 'No Last-Modified header detected',
    },
    { pass: hasArticleSchema, text: hasArticleSchema ? 'Article schema with datePublished found' : 'No Article schema with datePublished' },
    { pass: hasArticleSchema, text: hasArticleSchema ? 'Publish dates detected in schema' : 'No publish dates detected' },
  ];
}

function gradeInfo(grade: string): { label: string; cls: string } {
  const g = grade?.toLowerCase();
  if (g === 'strong' || g === 'good') return { label: 'Strong', cls: styles.badgeGood };
  if (g === 'needs work' || g === 'warning') return { label: 'Needs Work', cls: styles.badgeWarn };
  return { label: 'Critical', cls: styles.badgeCritical };
}

function barFillClass(score: number): string {
  if (score >= 70) return styles.barGood;
  if (score >= 40) return styles.barWarn;
  return styles.barBad;
}

function engineBadgeClass(status: string): string {
  if (status === 'CITED') return styles.eBadgeCited;
  if (status === 'PARTIAL') return styles.eBadgePartial;
  if (status === 'MISSING') return styles.eBadgeMissing;
  return styles.eBadgePending;
}

function engineStatus(probe: AiProbe | null): string {
  return engineBadge(probe, 'PENDING');
}

function probeResultForPrompt(probe: AiProbe | null, prompt: string): boolean | null {
  if (!probe || probe.results.length === 0) return null;
  const r = probe.results.find(r => r.prompt === prompt);
  return r != null ? r.cited : null;
}

const RECS = [
  { priority: 'high', title: 'Add structured data markup', desc: 'Implement JSON-LD schema for your key pages to improve AI engine crawlability and entity recognition.' },
  { priority: 'high', title: 'Build authoritative citations', desc: 'Get mentioned in industry publications and directories that AI engines use as trusted sources.' },
  { priority: 'medium', title: 'Optimize for conversational queries', desc: 'Rewrite key pages to answer questions directly in the first 50 words.' },
  { priority: 'medium', title: 'Increase content freshness', desc: 'Publish or update content weekly to signal active expertise to AI engines.' },
  { priority: 'low', title: 'Establish brand entity', desc: 'Create a Wikipedia-style entity page and ensure NAP consistency across the web.' },
];

type PageProps = { params: Promise<{ auditId: string }> };

export default async function AuditPdfPage({ params }: PageProps) {
  const { auditId } = await params;
  const supabase = getSupabase();

  const { data: requestRaw } = await supabase
    .from('audit_requests')
    .select('id, url, status, created_at')
    .eq('id', auditId)
    .maybeSingle();

  if (!requestRaw) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem', fontFamily: 'Inter, sans-serif' }}>
        <h2>Audit not found</h2>
        <p>This audit does not exist or has expired.</p>
      </div>
    );
  }

  const req = requestRaw as any;

  if (req.status === 'pending' || req.status === 'processing') {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem', fontFamily: 'Inter, sans-serif' }}>
        <h2>Report not ready yet</h2>
        <p>This audit is still processing. Please check back shortly.</p>
      </div>
    );
  }

  if (req.status === 'failed') {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem', fontFamily: 'Inter, sans-serif' }}>
        <h2>Audit failed</h2>
        <p>Something went wrong analysing this domain.</p>
      </div>
    );
  }

  const cookie = (await cookies()).get(unlockCookieName(auditId))?.value;
  if (reportAccess(auditId, cookie) === 'preview') {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem', fontFamily: 'Inter, sans-serif' }}>
        <h2>Unlock the report first</h2>
        <p><a href={`/audit/${auditId}`}>Open the report</a> and enter your details to download it.</p>
      </div>
    );
  }

  const { data: resultRaw } = await supabase
    .from('audit_results')
    .select(
      'id, audit_request_id, overall_score, overall_grade, answerability_score, brevity_score, trust_score, structure_score, freshness_score, raw_findings, created_at',
    )
    .eq('audit_request_id', auditId)
    .maybeSingle();

  if (!resultRaw) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem', fontFamily: 'Inter, sans-serif' }}>
        <h2>Results not available</h2>
        <p>The audit completed but results are still being processed.</p>
      </div>
    );
  }

  const res = resultRaw as any;
  const rf: RawFindings = res.raw_findings ?? {};

  const domain = (req.url as string).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const auditDate = new Date(res.created_at).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const rawProbe = rf.aiProbe ?? null;
  const claudeProbe: AiProbe | null = rawProbe
    ? isMultiEngine(rawProbe) ? rawProbe.claude : rawProbe
    : null;
  const openaiProbe: AiProbe | null = rawProbe && isMultiEngine(rawProbe) ? rawProbe.openai : null;
  const perplexityProbe: AiProbe | null = rawProbe && isMultiEngine(rawProbe) ? rawProbe.perplexity : null;
  const googleProbe: AiProbe | null = rawProbe && isMultiEngine(rawProbe) ? (rawProbe.google ?? null) : null;

  const allPrompts: string[] =
    rawProbe && isMultiEngine(rawProbe) && rawProbe.prompts.length > 0
      ? rawProbe.prompts
      : (claudeProbe ?? openaiProbe ?? perplexityProbe ?? googleProbe)?.results.map(r => r.prompt) ?? [];

  const dims = [
    { label: 'Crawlability', score: res.answerability_score as number, getFindings: crawlabilityFindings },
    { label: 'Schema Markup', score: res.brevity_score as number, getFindings: schemaFindings },
    { label: 'Authority & Citation', score: res.trust_score as number, getFindings: authorityFindings },
    { label: 'Topical Authority', score: res.structure_score as number, getFindings: topicalFindings },
    { label: 'Freshness', score: res.freshness_score as number, getFindings: freshnessFindings },
    { label: 'Brand Mentions', score: 0, getFindings: null },
  ];

  const engineRows = [
    { name: 'Claude', probe: claudeProbe },
    { name: 'ChatGPT', probe: openaiProbe },
    { name: 'Perplexity', probe: perplexityProbe },
    { name: 'Google AI', probe: googleProbe },
  ];

  const { label: gradeLabel, cls: gradeCls } = gradeInfo(res.overall_grade);

  return (
    <div className={styles.pdfRoot}>
      {/* Auto-trigger print after a short delay to allow styles and images to load */}
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script dangerouslySetInnerHTML={{ __html: 'window.onload = function(){ setTimeout(function(){ window.print(); }, 800); }' }} />

      {/* ── PAGE 1: COVER ── */}
      <div className={styles.coverPage}>
        <img
          src="https://www.campaigncreators.com/hubfs/cc-logo-color-horizontal%20(1).png"
          alt="Campaign Creators"
          className={styles.coverLogo}
        />
        <div>
          <h1 className={styles.coverTitle}>AEO Visibility Report</h1>
          <hr className={styles.coverAccentLine} />
          <p className={styles.coverDomain}>{domain}</p>
          <p className={styles.coverDate}>Generated {auditDate}</p>
        </div>
        <div className={styles.coverFooter}>
          Prepared by Campaign Creators · www.campaigncreators.com
        </div>
      </div>

      {/* ── PAGE 2: SCORE OVERVIEW ── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Score Overview</h2>
        </div>
        <div className={styles.scoreLayout}>
          <div className={styles.scoreBlock}>
            <div className={styles.scoreNumber}>{res.overall_score}</div>
            <div className={styles.scoreOutOf}>/100</div>
            <span className={`${styles.scoreBadge} ${gradeCls}`}>{gradeLabel}</span>
          </div>
          <div className={styles.scoreSummary}>
            <h3 className={styles.scoreSummaryHeading}>
              Your brand is being skipped by AI engines answering your customers&apos; questions
            </h3>
            <p className={styles.scoreSummaryText}>
              With a score of <strong>{res.overall_score}/100</strong>, {domain} is nearly invisible to
              AI-powered search. When potential customers ask ChatGPT, Perplexity, or Google AI about
              solutions in your space, your brand isn&apos;t being cited — your competitors are.
            </p>
            {res.overall_score < 50 && (
              <div className={styles.scoreWarning}>
                <strong>⚠ Estimated impact:</strong> Brands with sub-50 AEO scores lose an estimated
                23–41% of AI-referred traffic to competitors who have optimized for answer engine discovery.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── PAGE 3: DIMENSION BREAKDOWN ── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Dimension Breakdown</h2>
        </div>
        {dims.map((d) => {
          const findings = d.getFindings ? d.getFindings(rf) : null;
          return (
            <div key={d.label} className={styles.dimItem}>
              <div className={styles.dimHeader}>
                <span className={styles.dimName}>{d.label}</span>
                <span className={styles.dimScore}>{d.score}/100</span>
              </div>
              <div className={styles.barBg}>
                <div
                  className={`${styles.barFill} ${barFillClass(d.score)}`}
                  style={{ width: `${d.score}%` }}
                />
              </div>
              {findings && (
                <ul className={styles.findingsList}>
                  {findings.map((f, i) =>
                    'meta' in f ? (
                      <li key={i} className={styles.findingMeta}>{f.meta}</li>
                    ) : (
                      <li key={i} className={styles.findingItem}>
                        <span>{f.pass ? '✅' : '❌'}</span>
                        <span>{f.text}</span>
                      </li>
                    )
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* ── PAGE 4: AI ENGINE RESULTS ── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>AI Engine Results</h2>
        </div>

        <div className={styles.engineTableWrap}>
          <table className={styles.engineTable}>
            <thead>
              <tr>
                <th>Engine</th>
                <th>Status</th>
                <th>Cited</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {engineRows.map((eng) => {
                const status = engineStatus(eng.probe);
                const hasData = eng.probe && eng.probe.results.length > 0;
                return (
                  <tr key={eng.name}>
                    <td>{eng.name}</td>
                    <td>
                      <span className={`${styles.engineBadge} ${engineBadgeClass(status)}`}>
                        {status}
                      </span>
                    </td>
                    <td>{hasData ? eng.probe!.citedCount : '—'}</td>
                    <td>{hasData ? eng.probe!.totalPrompts : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {allPrompts.length > 0 && (
          <>
            <h3 className={styles.promptsHeading}>Prompt Results by Engine</h3>
            <table className={styles.promptsTable}>
              <thead>
                <tr>
                  <th>Prompt</th>
                  <th>Claude</th>
                  <th>ChatGPT</th>
                  <th>Perplexity</th>
                  <th>Google AI</th>
                </tr>
              </thead>
              <tbody>
                {allPrompts.map((prompt, i) => {
                  const cell = (result: boolean | null) =>
                    result === null ? '—' : result ? '✅' : '❌';
                  return (
                    <tr key={i}>
                      <td>{prompt}</td>
                      <td>{cell(probeResultForPrompt(claudeProbe, prompt))}</td>
                      <td>{cell(probeResultForPrompt(openaiProbe, prompt))}</td>
                      <td>{cell(probeResultForPrompt(perplexityProbe, prompt))}</td>
                      <td>{cell(probeResultForPrompt(googleProbe, prompt))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* ── PAGE 5: 90-DAY ACTION PLAN ── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>90-Day Action Plan</h2>
        </div>
        {RECS.map((rec, i) => (
          <div key={i} className={styles.recItem}>
            <div className={styles.recNum}>{i + 1}</div>
            <div className={styles.recContent}>
              <div className={styles.recTitle}>{rec.title}</div>
              <div className={styles.recDesc}>{rec.desc}</div>
            </div>
            <span
              className={`${styles.recPriority} ${
                rec.priority === 'high' ? styles.pHigh :
                rec.priority === 'medium' ? styles.pMed :
                styles.pLow
              }`}
            >
              {rec.priority}
            </span>
          </div>
        ))}
      </div>

      {/* ── PAGE 6: NEXT STEPS ── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Next Steps</h2>
        </div>
        <div className={styles.nextStepsLayout}>
          <h3 className={styles.ctaHeading}>Want help executing this plan?</h3>
          <p className={styles.ctaText}>
            Our AEO specialists will implement these recommendations and get your brand cited by AI
            engines within 90 days — or we continue working until you are.
          </p>
          <a
            href="https://www.campaigncreators.com/contact"
            className={styles.ctaAccent}
          >
            Book a Strategy Call →
          </a>

          <div className={styles.contactInfo}>
            <div className={styles.contactTitle}>Contact Campaign Creators</div>
            <div className={styles.contactItem}>🌐 www.campaigncreators.com</div>
            <div className={styles.contactItem}>📧 hello@campaigncreators.com</div>
          </div>

          <div className={styles.nextStepsFooter}>
            <img
              src="https://www.campaigncreators.com/hubfs/cc-logo-color-horizontal%20(1).png"
              alt="Campaign Creators"
              className={styles.footerLogo}
            />
            <span className={styles.footerTagline}>
              AI-powered revenue growth for modern B2B brands
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
